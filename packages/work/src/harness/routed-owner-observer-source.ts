/** Embedded only in the tracked managed supervisor. Default argv has no
 * observer and performs no addon/file/FD operation. This never reaches the
 * provider's argv, env or stdio and never consumes provider output. */
export const ROUTED_OWNER_OBSERVER_SOURCE = String.raw`
function privateProviderObserver() {
  const argv = process.argv.slice(1);
  if (argv.length === 0) return null;
  const fs = require('node:fs');
  const crypto = require('node:crypto');
  let native, fd, sender, pair, refusal, inheritedAttempted = false;
  const codes = new Set(['ACCESS','ALLOCATION','ARGUMENT','CAP','CHANNEL','CLEANUP','CLOSED',
    'COUNT','DEADLINE','DUPLICATE','FILESYSTEM','IDENTITY','NAPI','OWNERSHIP','PAIR',
    'SET_CHANGED','SHAPE','STATE','UID','UNSUPPORTED','UNKNOWN']);
  const fixed = error => {
    try {
      const d = error && typeof error === 'object' ? Object.getOwnPropertyDescriptor(error,'code') : null;
      return d && Object.hasOwn(d,'value') && typeof d.value === 'string' && codes.has(d.value) ? d.value : 'UNKNOWN';
    } catch { return 'UNKNOWN'; }
  };
  const latch = error => { if (refusal !== 'CLEANUP') refusal = fixed(error); };
  const need = value => { if (!value) throw new Error('OWNER_OBSERVER_REFUSED'); };
  const data = (value,key) => { const d = Object.getOwnPropertyDescriptor(value,key); need(d && Object.hasOwn(d,'value')); return d.value; };
  const same = (a,b) => ['dev','ino','uid','gid','mode','size','nlink','mtimeNs','ctimeNs'].every(k => a[k] === b[k]);
  const call = (name,...args) => native[name](...args);
  const close = (name,value) => {
    if (value === undefined) return;
    try { call(name,value); } catch (error) { if (fixed(error) !== 'CLOSED') latch(error); }
  };
  try {
    need(argv.length === 3 && argv[0] === '--private-owner-observer-v1'
      && typeof argv[1] === 'string' && argv[1].startsWith('/') && /^[a-f0-9]{64}$/.test(argv[2]));
    need(process.platform === 'linux' && process.versions.node === '22.23.0');
    fd = fs.openSync(argv[1],fs.constants.O_RDONLY|fs.constants.O_NOFOLLOW);
    const a = fs.fstatSync(fd,{bigint:true});
    need(a.isFile() && a.nlink === 1n && a.size > 0n && a.size <= 8388608n);
    const bytes = Buffer.alloc(Number(a.size)+1);
    let count = 0;
    while (count < bytes.length) {
      const n = fs.readSync(fd,bytes,count,bytes.length-count,null);
      if (n === 0) break; count += n;
    }
    need(count === Number(a.size));
    need(crypto.createHash('sha256').update(bytes.subarray(0,count)).digest('hex') === argv[2]
      && same(a,fs.fstatSync(fd,{bigint:true})) && same(a,fs.lstatSync(argv[1],{bigint:true})));
    const module = {exports:{}}; process.dlopen(module,'/proc/self/fd/'+fd);
    need(same(a,fs.fstatSync(fd,{bigint:true})) && same(a,fs.lstatSync(argv[1],{bigint:true})));
    native = Object.create(null);
    for (const name of ['spawnAndBind','inheritedSender','sendPair','close','closeChannel']) {
      const method = data(module.exports,name); need(typeof method === 'function');
      native[name] = (...args) => Reflect.apply(method,module.exports,args);
    }
    inheritedAttempted = true; sender = call('inheritedSender'); // checked CLOEXEC alias, closes FD4 before spawn
  } catch (error) { latch(error); }
  finally {
    if (fd !== undefined) try { fs.closeSync(fd); } catch { refusal = 'CLEANUP'; }
    if (!inheritedAttempted) try { fs.closeSync(4); } catch { refusal = 'CLEANUP'; }
  }
  return Object.freeze({
    spawn(command,args,options) {
      let child;
      if (!refusal) {
        try {
          const result = call('spawnAndBind',() => {
            child = spawn(command,args,options);
            need(Object.getPrototypeOf(child) === require('node:child_process').ChildProcess.prototype);
            const pid = data(child,'pid');
            need(Number.isSafeInteger(pid) && pid > 0 && data(child,'exitCode') === null && data(child,'signalCode') === null);
            return child;
          });
          need(result && typeof result === 'object' && data(result,'child') === child);
          pair = data(result,'handle'); need(pair);
        } catch (error) { latch(error); if (!child) throw error; }
      } else child = spawn(command,args,options); // exactly one normal spawn after pre-spawn loader refusal
      return child; // always attach the normal provider listeners/pipes next
    },
    send() {
      try { if (!refusal && pair && sender) call('sendPair',sender,pair); }
      catch (error) { latch(error); }
      finally { close('close',pair); close('closeChannel',sender); }
    },
    close() { close('close',pair); close('closeChannel',sender); },
  });
}
const privateOwnerObserver = privateProviderObserver();
`;
