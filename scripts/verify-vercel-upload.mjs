// Test the deployable function outside the repository so parent node_modules
// cannot hide dependencies missing from Vercel's traced output.
import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { resolve } from 'node:path';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { workbookFile, presentationFile } from '../tests/fixtures/office.js';
import { seedDocx, seedPdf } from '../tests/fixtures/seed-source.js';

const run = promisify(execFile);
const root = resolve(import.meta.dirname, '..');
const output = resolve(root, '.vercel/output/functions/![-]/catchall.func');
const isolated = await mkdtemp(resolve(tmpdir(), 'wiki-vercel-upload-'));
const bundled = resolve(isolated, 'function');
try {
	await cp(output, bundled, { recursive: true });
	const files = {
		xlsx: process.env.WIKIFY_TEST_XLSX
			? await readFile(process.env.WIKIFY_TEST_XLSX)
			: Buffer.from(await (await workbookFile()).arrayBuffer()),
		pptx: Buffer.from(await (await presentationFile()).arrayBuffer()),
		docx: await seedDocx('Deployment parsing verification'),
		pdf: seedPdf('Deployment parsing verification')
	};
	for (const [extension, bytes] of Object.entries(files))
		await writeFile(resolve(isolated, `input.${extension}`), bytes);
	const probe = `
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {pathToFileURL} from 'node:url';
import {resolve} from 'node:path';
let externalRequests = 0;
globalThis.fetch = async () => {externalRequests++; throw new Error('External requests are forbidden in the deployment probe');};
const {default: handler} = await import(pathToFileURL(resolve('function/.svelte-kit/vercel-tmp/index.js')));
const url = 'https://deployment-test.invalid/api/wikify';
assert.equal((await handler.fetch(new Request(url))).status, 405, 'The upload route must load before any file or external request');
const missingCanvas = process.argv[2] === 'without-canvas';
for (const extension of ['xlsx','docx','pptx','pdf']) {
 const body = new FormData();
 // A synthetic blocked filename stops after real extraction, before any AI/DB access.
 body.set('file', new File([await readFile('input.'+extension)],'900101-1000000.'+extension));
 body.set('editor','Editor-01');
 const response = await handler.fetch(new Request(url,{method:'POST',headers:{origin:new URL(url).origin},body}));
 assert.equal(response.status,422,extension+' must reach a controlled response');
 const payload = await response.json();
 assert.match(payload.message,missingCanvas && extension==='pdf' ? /파일을 읽을 수 없습니다/ : /콘텐츠 보호 검사로 초안 생성을 중단/);
}
assert.equal(externalRequests,0);
console.log(JSON.stringify({runtime:process.version,missingCanvas,formats:4,externalRequests}));
`;
	await writeFile(resolve(isolated, 'probe.mjs'), probe);
	const env = {
		...process.env,
		NODE_PATH: '',
		NODE_OPTIONS: '',
		DATABASE_URL: '',
		OPENAI_API_KEY: ''
	};
	const verify = async (mode) => {
		const result = await run(process.execPath, ['probe.mjs', mode], {
			cwd: isolated,
			env,
			timeout: 30000
		});
		assert.equal(result.stderr, '', 'No initialization or worker warnings expected');
		console.log(result.stdout.trim());
	};
	await verify('packaged');
	// Even an unavailable PDF native module must not disable Office uploads.
	await rm(resolve(bundled, 'node_modules/@napi-rs'), { recursive: true, force: true });
	await verify('without-canvas');
} finally {
	await rm(isolated, { recursive: true, force: true });
}
