#!/usr/bin/env python3
import json,re,subprocess,hashlib,os,tempfile
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

SHARE="/mnt/hdd/WebEdit/rule-set"
KEY="AnzWu29I"
ALLOW=["http://192.168.31.8:888","http://192.168.31.8"]
BRE=re.compile(r"^(rs-[a-z0-9-]+|bard-domains)$")
RKEYS={"domain","domain_suffix","domain_keyword","ip_cidr","process_name","package_name"}

class H(BaseHTTPRequestHandler):
    def _cors(self):
        o=self.headers.get("Origin","")
        if o in ALLOW: self.send_header("Access-Control-Allow-Origin",o)
        self.send_header("Access-Control-Allow-Headers","Content-Type,X-Vault-Key")
        self.send_header("Access-Control-Allow-Methods","GET,POST,OPTIONS")
        self.send_header("Access-Control-Allow-Private-Network","true")
        self.send_header("Cache-Control","no-store")
    def _json(self,code,obj):
        b=json.dumps(obj,ensure_ascii=False).encode()
        self.send_response(code);self._cors()
        self.send_header("Content-Type","application/json; charset=utf-8")
        self.send_header("Content-Length",str(len(b)));self.end_headers();self.wfile.write(b)
    def do_OPTIONS(self):
        self.send_response(204);self._cors();self.send_header("Content-Length","0");self.end_headers()
    def do_GET(self):
        if self.path=="/health": self._json(200,{"ok":True,"share":SHARE})
        else: self._json(404,{"error":"not found"})
    def do_POST(self):
        if self.path!="/publish": return self._json(404,{"error":"not found"})
        if self.headers.get("X-Vault-Key","")!=KEY: return self._json(401,{"error":"bad key"})
        try: n=int(self.headers.get("Content-Length","0")); body=json.loads(self.rfile.read(n))
        except Exception as e: return self._json(400,{"error":"bad body: %s"%e})
        bucket=body.get("bucket",""); content=body.get("content")
        if not BRE.match(bucket): return self._json(400,{"error":"bad bucket name"})
        if not os.path.isdir(SHARE): return self._json(503,{"error":"share not mounted"})
        try:
            doc=content if isinstance(content,dict) else json.loads(content)
        except Exception as e: return self._json(400,{"error":"bad json: %s"%e})
        rules=doc.get("rules")
        if not isinstance(rules,list) or not rules: return self._json(400,{"error":"rules[] required"})
        for r in rules:
            if not isinstance(r,dict) or not r: return self._json(400,{"error":"empty rule"})
            bad=set(r.keys())-RKEYS
            if bad: return self._json(400,{"error":"unknown rule keys: %s"%bad})
            for v in r.values():
                if not isinstance(v,list) or not v or not all(isinstance(x,str) and x for x in v):
                    return self._json(400,{"error":"rule values must be non-empty string arrays"})
        doc={"version":1,"rules":rules}
        jtxt=json.dumps(doc,ensure_ascii=False,indent=2)+"\n"
        with tempfile.TemporaryDirectory() as td:
            jp,sp=os.path.join(td,"a.json"),os.path.join(td,"a.srs")
            open(jp,"w").write(jtxt)
            p=subprocess.run(["/usr/local/bin/sing-box","rule-set","compile",jp,"-o",sp],
                             capture_output=True,text=True,timeout=20)
            if p.returncode!=0: return self._json(500,{"error":"compile failed","stderr":p.stderr[-400:]})
            srs=open(sp,"rb").read()
        open(os.path.join(SHARE,bucket+".json"),"w").write(jtxt)
        open(os.path.join(SHARE,bucket+".srs"),"wb").write(srs)
        self._json(200,{"ok":True,"bucket":bucket,"json":len(jtxt.encode()),"srs":len(srs),
                        "sha256":hashlib.sha256(srs).hexdigest()[:16],"hint":"两台路由约 60s 内自动刷新"})
    def log_message(self,*a): pass

ThreadingHTTPServer(("0.0.0.0",9099),H).serve_forever()
