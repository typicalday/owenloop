// Harmless bounded RPC work. No environment/provider/account/native access.
import readline from 'node:readline';
import { pbkdf2 } from 'node:crypto';
let count=0,working=false;
const rl=readline.createInterface({input:process.stdin});
process.stdout.on('error',()=>{process.exitCode=2;});
process.stdin.on('error',()=>{process.exitCode=2;});
rl.on('line',line=>{
 if(++count>1||line.length>1024||working){process.exitCode=2;rl.close();return;}
 let m;try{m=JSON.parse(line);}catch{process.exitCode=2;rl.close();return;}
 if(m.method!=='bounded-work'||!Number.isSafeInteger(m.id)){process.exitCode=2;rl.close();return;}
 working=true;
 // Fixed work starts independently of observer collection or acknowledgement.
 pbkdf2('harmless','fixed',1000000,32,'sha256',error=>{
  process.stdout.write(JSON.stringify(error?{id:m.id,error:{code:1,message:'WORK_REFUSED'}}:{id:m.id,result:'WORK_COMPLETE'})+'\n',()=>{rl.close();process.stdin.destroy();});
  if(error)process.exitCode=2;
 });
});
