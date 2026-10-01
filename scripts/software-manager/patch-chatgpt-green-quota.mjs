import fs from 'node:fs';import path from 'node:path';
import {modelCatalog,codexBridgeRouteIdForModel,readRouterConfig} from '../../desktop/settings.mjs';
import {collectQuotaIndependentModelIds} from '../../shared/codex-quota-ui-transform.mjs';
import {createQuotaCompatibleGreenCopy} from './green-quota-compat.mjs';
const args=new Map();for(let i=2;i<process.argv.length;i+=2){if(!['--input','--output','--backup','--report','--router-root'].includes(process.argv[i])||!process.argv[i+1])throw Error('quota_cli_argument_invalid');args.set(process.argv[i],path.resolve(process.argv[i+1]));}
for(const key of ['--input','--output','--backup','--report'])if(!args.has(key))throw Error('quota_cli_argument_required');
const root=args.get('--router-root')||process.cwd();
const known=modelCatalog(root).map(m=>({id:codexBridgeRouteIdForModel(m),authMode:m.authMode}));
const configured=readRouterConfig(root)?.models??[];
const ids=collectQuotaIndependentModelIds([...known,...configured]);
if(fs.existsSync(args.get('--report')))throw Error('quota_report_occupied');
const result=await createQuotaCompatibleGreenCopy({inputPath:args.get('--input'),outputPath:args.get('--output'),backupPath:args.get('--backup'),apiModelIds:ids,onProgress:message=>console.log(message)});
fs.mkdirSync(path.dirname(args.get('--report')),{recursive:true});
fs.writeFileSync(args.get('--report'),JSON.stringify(result,null,2)+'\n',{flag:'wx'});
console.log(`GREEN_QUOTA_COPY_VERIFIED models=${ids.length} output=${result.outputPath}`);
