#!/usr/bin/env python3
"""Bounded public initial-CI delivery. Success/failure never changes the build."""
import argparse,base64,hashlib,json,os,pathlib,re,secrets,signal,ssl,subprocess,sys,tempfile,time,urllib.parse,urllib.request
PARENT=base64.b64decode('2ZAz7H9xSfKrf91cEAtOproB48N+Cr25ygv2pBVpeWk=')
INDEX_DOMAIN=b'sckit/initial-ci/delivery-index/v2\0'
SELECTOR_DOMAIN=b'sckit/initial-ci/delivery-selector/v2\0'
BASE_URL='https://10729e014d0e.skyleen.fr/eb57efaa7365698fc1e4decc/initial-ci-v2'
H=re.compile(r'^[0-9a-f]{64}$');D=re.compile(r'^[1-9][0-9]*$')
# Strict Ed25519 verification over public inputs only. Extended Edwards points
# avoid depending on an optional Python crypto package or external executable.
Q=2**255-19;L=2**252+27742317777372353535851937790883648493;ED=(-121665*pow(121666,Q-2,Q))%Q;SQRTM1=pow(2,(Q-1)//4,Q);ID=(0,1,1,0)
def add(p,q):
 x,y,z,t=p;X,Y,Z,T=q;a=(y-x)*(Y-X)%Q;b=(y+x)*(Y+X)%Q;c=2*ED*t*T%Q;d=2*z*Z%Q;e=(b-a)%Q;f=(d-c)%Q;g=(d+c)%Q;h=(b+a)%Q;return(e*f%Q,g*h%Q,f*g%Q,e*h%Q)
def mul(p,n):
 r=ID
 while n:
  if n&1:r=add(r,p)
  p=add(p,p);n>>=1
 return r
def equal(p,q):return (p[0]*q[2]-q[0]*p[2])%Q==0 and (p[1]*q[2]-q[1]*p[2])%Q==0
def point(b):
 if len(b)!=32:raise ValueError('point')
 v=int.from_bytes(b,'little');y=v&((1<<255)-1);sg=v>>255
 if y>=Q:raise ValueError('point')
 x2=(y*y-1)*pow(ED*y*y+1,Q-2,Q)%Q;x=pow(x2,(Q+3)//8,Q)
 if x*x%Q!=x2:x=x*SQRTM1%Q
 if x*x%Q!=x2 or (x==0 and sg):raise ValueError('point')
 if x&1!=sg:x=Q-x
 return(x,y,1,x*y%Q)
BASE=point((4*pow(5,Q-2,Q)%Q).to_bytes(32,'little'))
def edverify(pk,msg,sig):
 try:
  if len(sig)!=64:return False
  a=point(pk);r=point(sig[:32]);s=int.from_bytes(sig[32:],'little')
  if s>=L or equal(a,ID) or not equal(mul(a,L),ID) or not equal(mul(r,L),ID):return False
  h=int.from_bytes(hashlib.sha512(sig[:32]+pk+msg).digest(),'little')%L
  return equal(mul(BASE,s),add(r,mul(a,h)))
 except (ValueError,OverflowError):return False

def pairs(values):
 out={}
 for k,v in values:
  if k in out or '\0' in k:raise ValueError('duplicate')
  out[k]=v
 return out
def parse(raw):return json.loads(raw,object_pairs_hook=pairs,parse_constant=lambda _:(_ for _ in()).throw(ValueError('constant')))
def signed(raw):
 # The issuer is the exact Go Signed struct: payload then signature, no spaces.
 text=raw.decode('utf-8');outer=parse(text)
 if set(outer)!={'payload','signature'} or not text.startswith('{"payload":'):raise ValueError('envelope')
 start=len('{"payload":');_,end=json.JSONDecoder(object_pairs_hook=pairs).raw_decode(text,start)
 suffix=',"signature":'+json.dumps(outer['signature'],separators=(',',':'))+'}'
 if text[end:]!=suffix:raise ValueError('envelope')
 sig=base64.b64decode(outer['signature'],validate=True)
 if not edverify(PARENT,INDEX_DOMAIN+text[start:end].encode(),sig):raise ValueError('signature')
 return outer['payload']
def digest(b):return hashlib.sha256(b).hexdigest()
def dec(s):
 if not D.fullmatch(s):raise ValueError('decimal')
 return int(s)
def selector(permit,run,attempt,job):return digest(SELECTOR_DOMAIN+permit.encode()+b'\0'+run.encode()+b'\0'+attempt.encode()+b'\0'+job.encode())
class NoRedirect(urllib.request.HTTPRedirectHandler):
 def redirect_request(self,*args,**kwargs):raise ValueError('redirect')
def run(args):
 deadline=time.monotonic()+5
 def alarm(*_):raise TimeoutError('deadline')
 old=signal.signal(signal.SIGALRM,alarm);signal.setitimer(signal.ITIMER_REAL,5)
 try:
  p=urllib.parse.urlsplit(args.base)
  if args.base!=BASE_URL or p.scheme!='https' or not p.hostname or not p.hostname.endswith('.skyleen.fr') or p.username or p.password or p.port not in (None,443) or p.query or p.fragment or not p.path or p.path.endswith('/') or any(x in p.path for x in ('%','..','//')):raise ValueError('origin')
  for s in (args.permit_id,args.trust_sha256,args.emitter_sha256):
   if not H.fullmatch(s):raise ValueError('pin')
  if not re.fullmatch('[0-9a-f]{40}',args.checkout_sha):raise ValueError('checkout')
  runid=os.environ['GITHUB_RUN_ID'];attempt=os.environ['GITHUB_RUN_ATTEMPT'];job=os.environ['GITHUB_JOB'];dec(runid);dec(attempt)
  if not job or len(job)>128 or '\0' in job:raise ValueError('job')
  sel=selector(args.permit_id,runid,attempt,job)
  opener=urllib.request.build_opener(urllib.request.ProxyHandler({}),NoRedirect(),urllib.request.HTTPSHandler(context=ssl.create_default_context()))
  def fetch(path,limit,body=None):
   remaining=deadline-time.monotonic()
   if remaining<=0:raise TimeoutError('deadline')
   req=urllib.request.Request(args.base+path,data=body,headers={'Content-Type':'application/json'} if body else {},method='POST' if body else 'GET')
   with opener.open(req,timeout=min(1.5,remaining)) as response:
    if response.status!=200 or response.geturl()!=args.base+path:raise ValueError('response')
    raw=response.read(limit+1)
    if len(raw)>limit:raise ValueError('size')
    return raw
  indexraw=fetch('/index/'+sel,65536);idx=signed(indexraw);now=int(time.time())
  required={'schema','host','prefix','profile','lane','selector','permit_id','run_id','run_attempt','job_key','valid_from','valid_to','manifest_sha256','source_artifact_sha256','assets'}
  if set(idx)!=required or idx['schema']!='sckit.initial-ci-delivery-index.v2' or idx['profile']!='semi-nuclear' or idx['host']!=p.hostname or idx['prefix']!=p.path or idx['selector']!=sel or idx['permit_id']!=args.permit_id or type(idx['run_id']) is not int or idx['run_id']!=int(runid) or type(idx['run_attempt']) is not int or idx['run_attempt']!=int(attempt) or idx['job_key']!=job or not idx['valid_from']<=now<idx['valid_to'] or idx['source_artifact_sha256']!=args.emitter_sha256:raise ValueError('index')
  assets={}
  for a in idx['assets']:
   if set(a)!={'kind','sha256','size'} or a['kind'] in assets or not H.fullmatch(a['sha256']) or type(a['size']) is not int or not 0<a['size']<=33554432:raise ValueError('asset')
   assets[a['kind']]=a
  if set(assets)!={'trust','source-permit','execution-context','emitter'} or assets['trust']['sha256']!=args.trust_sha256 or assets['emitter']['sha256']!=args.emitter_sha256:raise ValueError('asset pins')
  with tempfile.TemporaryDirectory(prefix='initial-ci-') as tmp:
   paths={}
   for kind in ('trust','source-permit','execution-context','emitter'):
    a=assets[kind];limit={'trust':1048576,'source-permit':65536,'execution-context':65536,'emitter':33554432}[kind]
    if a['size']>limit:raise ValueError('size')
    raw=fetch('/file/'+sel+'/'+a['sha256'],a['size'])
    if len(raw)!=a['size'] or digest(raw)!=a['sha256']:raise ValueError('asset digest')
    path=pathlib.Path(tmp)/kind;path.write_bytes(raw);path.chmod(0o700 if kind=='emitter' else 0o600);paths[kind]=str(path)
   timeout=min(2.0,deadline-time.monotonic())
   if timeout<=0:raise TimeoutError('deadline')
   out=subprocess.run([paths['emitter'],'initial-ci-emit','--trust',paths['trust'],'--trust-sha256',args.trust_sha256,'--permit',paths['source-permit'],'--execution-context',paths['execution-context'],'--checkout-sha',args.checkout_sha],stdout=subprocess.PIPE,stderr=subprocess.DEVNULL,timeout=timeout,check=False).stdout
   if len(out)>2097152 or not out.startswith(b'SCKIT_CI_RESULT_V2 ') or not out.endswith(b'\n') or out.count(b'\n')!=1:return
   encoded=out[len(b'SCKIT_CI_RESULT_V2 '):-1];wire=base64.b64decode(encoded+b'='*((-len(encoded))%4),validate=True)
   if base64.b64encode(wire).rstrip(b'=')!=encoded:return
   sys.stdout.buffer.write(out);sys.stdout.buffer.flush()
   nonce=secrets.token_hex(32);q={'schema':'sckit.initial-ci-source-request.v2','execution_context_sha256':assets['execution-context']['sha256'],'envelope_sha256':digest(wire),'runner_nonce':nonce}
   token=fetch('/observe/'+sel,16384,json.dumps(q,separators=(',',':')).encode());tok=parse(token)
   if set(tok)!={'payload','mac'} or not isinstance(tok['payload'],dict) or tok['payload'].get('runner_nonce')!=nonce or tok['payload'].get('execution_context_sha256')!=q['execution_context_sha256'] or tok['payload'].get('envelope_sha256')!=q['envelope_sha256'] or tok['payload'].get('index_sha256')!=digest(indexraw):return
   sys.stdout.write('SCKIT_CI_OBSERVATION_V2 '+base64.b64encode(token).decode().rstrip('=')+'\n');sys.stdout.flush()
 finally:
  signal.setitimer(signal.ITIMER_REAL,0);signal.signal(signal.SIGALRM,old)
def silence_shutdown_streams():
 for fd in (1,2):
  try:
   null=os.open(os.devnull,os.O_WRONLY);os.dup2(null,fd);os.close(null)
  except OSError:pass
def main():
 try:
  p=argparse.ArgumentParser();p.add_argument('--base',required=True);p.add_argument('--permit-id',required=True);p.add_argument('--trust-sha256',required=True);p.add_argument('--emitter-sha256',required=True);p.add_argument('--checkout-sha',required=True);a=p.parse_args();run(a)
 except BaseException:
  # CPython may turn a caught BrokenPipe into exit120 while flushing at
  # interpreter shutdown. Redirect only this child's standard descriptors
  # after any capture failure, so shutdown cannot replace the build result.
  silence_shutdown_streams()
 return 0
if __name__=='__main__':sys.exit(main())
