export const longConnectionLabel =
	'<img src=x onerror=alert(1)> & ' + '긴 원문 표기 '.repeat(24).trim();
export const connectionSource = [
	'## 연결 확인',
	'공정 별칭을 확인합니다. [[guide|저장된 안내]] [[guide|저장된 안내]]',
	'[[long-target|' + longConnectionLabel + ']]',
	'`코드 전용` [[reading-connections|나 자신]] [[아직 없는 문서]] [[archived]]'
].join('\n\n');

export async function seedReadingConnections(sql) {
	const documents = {};
	for (const [key, title, slug, content] of [
		['source', '교대 기록', 'reading-connections', connectionSource],
		['automatic', 'RFCC', 'fixed-rfcc', '공정의 가상 점검 자료입니다.'],
		['manual', '정비 절차', 'guide', '절차의 가상 점검 자료입니다.'],
		[
			'long',
			'긴 문서 제목과 주소를 확인하는 점검 자료 '.repeat(6).trim(),
			'long-target',
			'긴 제목의 점검 자료입니다.'
		],
		['incomingAuto', '자동 참조', 'incoming-auto', '기록 별칭을 확인합니다.'],
		[
			'incomingManual',
			'직접 참조',
			'incoming-manual',
			'[저장된 교대 링크](/wiki/old-handover#section-1)'
		],
		['ignored', '코드 전용', 'ignored', '`교대 기록` [교대 기록](https://example.invalid/)'],
		['isolated', '독립 자료', 'isolated', '다른 문서와 연결되지 않은 가상 자료입니다.']
	]) {
		const [row] =
			await sql`INSERT INTO documents(title,slug,content) VALUES(${title},${slug},${content}) RETURNING *`;
		documents[key] = row;
	}
	await sql`INSERT INTO documents(title,slug,content,deleted_at,deleted_by) VALUES('보관 자료','archived','보관한 가상 자료입니다.',NOW(),'Editor-01')`;
	await sql`INSERT INTO redirects(alias_slug,alias_title,document_id) VALUES('old-handover','기록 별칭',${documents.source.id}),('old-rfcc','공정 별칭',${documents.automatic.id})`;
	await sql`INSERT INTO revisions(document_id,content,editor_handle) VALUES(${documents.source.id},${documents.source.content},'Editor-01')`;
	return documents;
}
