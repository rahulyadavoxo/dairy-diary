# local no-auth HTTP proxy that forwards to upstream $HTTPS_PROXY with credentials
import os,socket,threading,base64,urllib.parse as u,select
p=u.urlparse(os.environ['HTTPS_PROXY'])
UP=(p.hostname,p.port); AUTH=base64.b64encode(f"{u.unquote(p.username)}:{u.unquote(p.password)}".encode()).decode()
def pipe(a,b):
    try:
        socks=[a,b]
        while True:
            r,_,_=select.select(socks,[],[],300)
            if not r: break
            for s in r:
                d=s.recv(65536)
                if not d: return
                (b if s is a else a).sendall(d)
    except Exception: pass
    finally: a.close(); b.close()
def handle(c):
    try:
        buf=b''
        while b'\r\n\r\n' not in buf:
            d=c.recv(65536)
            if not d: c.close(); return
            buf+=d
        head,rest=buf.split(b'\r\n\r\n',1)
        lines=head.split(b'\r\n')
        lines=[l for l in lines if not l.lower().startswith(b'proxy-authorization')]
        lines.insert(1,b'Proxy-Authorization: Basic '+AUTH.encode())
        s=socket.create_connection(UP)
        s.sendall(b'\r\n'.join(lines)+b'\r\n\r\n'+rest)
        pipe(c,s)
    except Exception: c.close()
srv=socket.socket(); srv.setsockopt(socket.SOL_SOCKET,socket.SO_REUSEADDR,1); srv.bind(('127.0.0.1',8899)); srv.listen(100)
while True:
    c,_=srv.accept(); threading.Thread(target=handle,args=(c,),daemon=True).start()
