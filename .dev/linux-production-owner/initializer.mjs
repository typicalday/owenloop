// A separately declared private preloader for the two embedded nested entries.
import {install,binding} from './loader.mjs';
const b=binding();
if(process.argv[1]===b.provider)install('provider');
else if(process.argv[1]==='--private-owner-observer-v1'&&process.argv.length===4&&process.argv[2]===b.artifact&&process.argv[3]===b.artifactSha256)install('supervisor');
else throw new Error('UNDECLARED_INITIALIZER');
