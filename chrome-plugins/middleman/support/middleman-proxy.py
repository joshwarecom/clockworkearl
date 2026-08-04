import argparse
import json
import select
import socket
import threading

HOST_MAPPINGS = {}

# Active sockets tracking for force-eviction
ACTIVE_SOCKETS = {}
mapping_lock = threading.Lock()

LOCAL_PROXY_HOST = "127.0.0.1"
LOCAL_PROXY_PORT = 8080

def update_mapping_and_evict(host, new_ip):
    clean_host = host.lower()
    with mapping_lock:
        old_ip = HOST_MAPPINGS.get(clean_host)
        HOST_MAPPINGS[clean_host] = new_ip
        print(f"📥 [Mapping Updated] {clean_host} -> {new_ip}")

        if old_ip and old_ip != new_ip:
            sockets_to_close = ACTIVE_SOCKETS.pop(clean_host, [])
            if sockets_to_close:
                print(
                    f"🧹 [Evicting Pool] Closing {len(sockets_to_close)} socket(s) for {clean_host}"
                )
                for client_sock, remote_sock in sockets_to_close:
                    for s in (client_sock, remote_sock):
                        try:
                            s.shutdown(socket.SHUT_RDWR)
                        except Exception:
                            pass
                        try:
                            s.close()
                        except Exception:
                            pass


def register_socket(host, client_sock, remote_sock):
    clean_host = host.lower()
    with mapping_lock:
        if clean_host not in ACTIVE_SOCKETS:
            ACTIVE_SOCKETS[clean_host] = []
        ACTIVE_SOCKETS[clean_host].append((client_sock, remote_sock))


def unregister_socket(host, client_sock, remote_sock):
    clean_host = host.lower()
    with mapping_lock:
        if clean_host in ACTIVE_SOCKETS:
            ACTIVE_SOCKETS[clean_host] = [
                p
                for p in ACTIVE_SOCKETS[clean_host]
                if p != (client_sock, remote_sock)
            ]


def handle_client(client_socket):
    remote_socket = None
    target_host = None
    try:
        raw_header = client_socket.recv(16384)
        if not raw_header:
            client_socket.close()
            return

        header_str = raw_header.decode("utf-8", errors="ignore")
        lines = header_str.split("\r\n")
        first_line = lines[0] if lines else ""


        if "GET /__mmp_check__" in first_line:
            body_index = header_str.find("\r\n\r\n")
            try:
                response = (
                    "HTTP/1.1 200 OK\r\n"
                    "Access-Control-Allow-Origin: *\r\n"
                    "Content-Type: application/json\r\n"
                    "Connection: close\r\n\r\n"
                    '{"status":"online"}'
                )
                print(f"🌐 [HTTP Request] MMP Check received.")
                client_socket.sendall(response.encode("utf-8"))
            except Exception as ex:
                print(f"❌ [MMP Check Error] {ex}")
            client_socket.close()
            return

        # -------------------------------------------------------------
        # 1. CONTROL PLANE: Update Mapping Endpoint
        # -------------------------------------------------------------
        if "POST /__bind_next__" in first_line:
            body_index = header_str.find("\r\n\r\n")
            if body_index != -1:
                body_str = header_str[body_index + 4 :]
                try:
                    payload = json.loads(body_str)
                    host = payload.get("host", "").strip()
                    target_ip = payload.get("target_ip", "").strip()

                    if host and target_ip:
                        update_mapping_and_evict(host, target_ip)

                    response = (
                        "HTTP/1.1 200 OK\r\n"
                        "Access-Control-Allow-Origin: *\r\n"
                        "Content-Type: application/json\r\n"
                        "Connection: close\r\n\r\n"
                        '{"status":"updated"}'
                    )
                    client_socket.sendall(response.encode("utf-8"))
                except Exception as ex:
                    print(f"❌ [Payload Error] {ex}")

            client_socket.close()
            return

        # -------------------------------------------------------------
        # 2. DATA PLANE: Tunneling (HTTPS & HTTP)
        # -------------------------------------------------------------
        parts = first_line.split(" ")
        if len(parts) < 2:
            client_socket.close()
            return

        method = parts[0].upper()
        raw_target = parts[1]

        if method == "CONNECT":
            # --- HTTPS MODE ---
            target_host = raw_target.split(":")[0].lower()
            target_port = (
                int(raw_target.split(":")[1]) if ":" in raw_target else 443
            )

            with mapping_lock:
                dest_ip = HOST_MAPPINGS.get(target_host, target_host)

            print(
                f"🔒 [HTTPS Tunnel] {target_host} -> {dest_ip}:{target_port}"
            )

            remote_socket = socket.create_connection((dest_ip, target_port))
            register_socket(target_host, client_socket, remote_socket)

            # Send 200 OK to Chrome so it starts the TLS handshake
            client_socket.sendall(b"HTTP/1.1 200 Connection Established\r\n\r\n")

        else:
            # --- PLAIN HTTP MODE ---
            # Extract Host header from HTTP request
            host_header = None
            for line in lines[1:]:
                if line.lower().startswith("host:"):
                    host_header = line.split(":", 1)[1].strip()
                    break

            if host_header:
                target_host = host_header.split(":")[0].lower()
                target_port = (
                    int(host_header.split(":")[1])
                    if ":" in host_header
                    else 80
                )
            else:
                clean_target = (
                    raw_target.replace("http://", "")
                    .replace("https://", "")
                    .split("/")[0]
                )
                target_host = clean_target.split(":")[0].lower()
                target_port = (
                    int(clean_target.split(":")[1])
                    if ":" in clean_target
                    else 80
                )

            with mapping_lock:
                dest_ip = HOST_MAPPINGS.get(target_host, target_host)

            print(f"🌐 [HTTP Request] {target_host} -> {dest_ip}:{target_port}")

            remote_socket = socket.create_connection((dest_ip, target_port))
            register_socket(target_host, client_socket, remote_socket)

            # Convert proxy absolute URL (http://example.com/path) into relative URL (/path)
            if raw_target.startswith("http://"):
                path_start = raw_target.find("/", 7)
                relative_path = (
                    raw_target[path_start:] if path_start != -1 else "/"
                )
                first_line_modified = f"{method} {relative_path} {parts[2]}"
                
                # Replace only the first line in raw_header
                header_bytes = raw_header
                first_line_bytes = first_line.encode("utf-8")
                modified_first_line_bytes = first_line_modified.encode("utf-8")
                
                header_bytes = header_bytes.replace(first_line_bytes, modified_first_line_bytes, 1)
                remote_socket.sendall(header_bytes)
            else:
                remote_socket.sendall(raw_header)

        # Pipe raw encrypted/plain traffic transparently
        sockets = [client_socket, remote_socket]
        while True:
            readable, _, exceptional = select.select(sockets, [], sockets, 10)
            if exceptional:
                break
            for sock in readable:
                other_sock = (
                    remote_socket if sock is client_socket else client_socket
                )
                data = sock.recv(16384)
                if not data:
                    return
                other_sock.sendall(data)

    except Exception as e:
        pass
    finally:
        if target_host and remote_socket:
            unregister_socket(target_host, client_socket, remote_socket)
        if remote_socket:
            try:
                remote_socket.close()
            except Exception:
                pass
        try:
            client_socket.close()
        except Exception:
            pass


def start_proxy(port):
    server = socket.socket(socket.AF_INET, socket.SOCK_STREAM)
    server.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
    server.bind((LOCAL_PROXY_HOST, port))
    server.listen(100)
    print(
        f"🚀 Middleman Proxy (HTTP & HTTPS) listening on http://{LOCAL_PROXY_HOST}:{port}\n"
    )

    while True:
        client_sock, addr = server.accept()
        t = threading.Thread(target=handle_client, args=(client_sock,))
        t.daemon = True
        t.start()


if __name__ == "__main__":
    parser = argparse.ArgumentParser(description="Middleman Local Proxy Server")
    parser.add_argument(
        "-p", "--port",
        type=int,
        default=8080,
        help="Port to run the proxy server on (default: 8080)"
    )
    args = parser.parse_args()
    start_proxy(args.port)