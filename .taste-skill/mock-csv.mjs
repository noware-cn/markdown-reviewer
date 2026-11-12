/* 临时：往 mock PR 里塞一份 CSV，用于人工核对表格视图；核对后用 --restore 还原 */
import fs from 'node:fs';
import { execFileSync } from 'node:child_process';

const FILE = 'src/mock-diff.ts';
const BACKUP = '.taste-skill/mock-diff.backup.ts';

const base = [
  '客户编号,客户名称,行业,授信额度,已用额度,风险状态',
  'C001,华东制造集团,制造业,8000000,3200000,正常',
  'C002,北方贸易有限公司,批发零售,5000000,4800000,关注',
  'C003,西部能源股份,能源,12000000,1500000,正常',
  'C004,南方物流控股,交通运输,3000000,900000,正常',
  'C005,东部医药集团,医药,6000000,2600000,正常',
  'C006,中原建材集团,建材,4500000,4400000,关注',
  'C007,"海西电子科技(厦门),有限公司",电子,2000000,600000,正常',
  'C008,滨江食品股份,食品,1500000,1200000,正常',
  'C009,云岭旅游发展,文旅,900000,850000,关注',
  'C010,金桥融资租赁,金融,20000000,16000000,正常',
].join('\n') + '\n';

const head = [
  '客户编号,客户名称,行业,授信额度,已用额度,风险状态',
  'C001,华东制造集团,制造业,8000000,3200000,正常',
  'C002,北方贸易有限公司,批发零售,5000000,5100000,关注',
  'C003,西部能源股份,能源,12000000,1500000,正常',
  'C005,东部医药集团,医药,6000000,2600000,正常',
  'C006,中原建材集团,建材,4500000,4400000,关注',
  'C007,"海西电子科技(厦门),有限公司",电子,2000000,600000,关注',
  'C008,滨江食品股份,食品,1500000,1200000,正常',
  'C009,云岭旅游发展,文旅,900000,850000,关注',
  'C010,金桥融资租赁,金融,20000000,16000000,正常',
  'C011,北辰新能源,能源,7000000,1200000,正常',
].join('\n') + '\n';

if (process.argv.includes('--restore')) {
  fs.copyFileSync(BACKUP, FILE);
  console.log('restored');
  process.exit(0);
}

fs.copyFileSync(FILE, BACKUP);
const src = fs.readFileSync(FILE, 'utf8');
const open = src.indexOf('=> (') + 4;
const close = src.lastIndexOf(');');
const payload = JSON.parse(src.slice(open, close));

fs.writeFileSync('/tmp/base.csv', base);
fs.writeFileSync('/tmp/head.csv', head);
const diff = (() => {
  try {
    return execFileSync('git', ['diff', '--no-index', '--unified=3', '--', '/tmp/base.csv', '/tmp/head.csv'],
      { encoding: 'utf8' });
  } catch (err) {
    if (err.stdout) return err.stdout; // git diff 有差异时退出码为 1
    throw err;
  }
})();
const patch = diff.slice(diff.indexOf('\n@@')).replace(/^\n/, '').replace(/\n$/, '');
const count = (sign) => patch.split('\n').filter((l) => l.startsWith(sign)).length;

const path = 'docs/客户数据/授信台账.csv';
payload.files.unshift({
  path,
  previousPath: null,
  status: 'modified',
  additions: count('+'),
  deletions: count('-'),
  patch,
  isMarkdown: false,
});
payload.texts[path] = { base, head };
payload.meta.changedFiles = payload.files.length;
fs.writeFileSync(FILE, src.slice(0, open) + JSON.stringify(payload) + src.slice(close));
console.log('injected', path, `+${count('+')}/-${count('-')}`, 'patch lines', patch.split('\n').length);
