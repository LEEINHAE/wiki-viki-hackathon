import assert from 'node:assert/strict';
import { applyMigrations } from './migration-runner.js';

export const identifier = (value) => {
	assert.match(value, /^[a-z_][a-z0-9_]*$/);
	return `"${value}"`;
};
const quote = (value) => `'${value.replaceAll("'", "''")}'`;

export async function readLegacySnapshot(tx, source) {
	identifier(source);
	await tx`SELECT set_config('search_path',${source},true)`;
	assert.equal((await tx`SELECT current_schema() AS name`)[0].name, source);
	const tables =
		await tx`SELECT tablename AS name FROM pg_tables WHERE schemaname=${source} ORDER BY tablename`;
	const columns =
		await tx`SELECT table_name,column_name,column_default FROM information_schema.columns WHERE table_schema=${source} ORDER BY table_name,ordinal_position`;
	const sequences =
		await tx`SELECT sequencename AS name,start_value::text,min_value::text,max_value::text,increment_by::text,cycle,cache_size::text FROM pg_sequences WHERE schemaname=${source} ORDER BY sequencename`;
	const foreignKeys =
		await tx`SELECT c.relname AS table_name,con.conname AS name,pg_get_constraintdef(con.oid) AS definition FROM pg_constraint con JOIN pg_class c ON c.oid=con.conrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${source} AND con.contype='f' ORDER BY c.relname,con.conname`;
	const functions =
		await tx`SELECT p.proname AS name,pg_get_functiondef(p.oid) AS definition FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname=${source} ORDER BY p.proname`;
	const views =
		await tx`SELECT viewname AS name,definition FROM pg_views WHERE schemaname=${source} ORDER BY CASE viewname WHEN 'wiki_resolved_documents' THEN 0 ELSE 1 END,viewname`;
	const triggers =
		await tx`SELECT c.relname AS table_name,t.tgname AS name,t.tgenabled AS enabled,pg_get_triggerdef(t.oid) AS definition FROM pg_trigger t JOIN pg_class c ON c.oid=t.tgrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${source} AND NOT t.tgisinternal ORDER BY c.relname,t.tgname`;
	const counts = {};
	for (const table of tables) {
		identifier(table.name);
		counts[table.name] = Number(
			(await tx`SELECT count(*) AS n FROM ${tx(`${source}.${table.name}`)}`)[0].n
		);
	}
	// These populated domains require additional identity/source mappings.
	// Never silently omit them if the connected database changes later.
	for (const name of [
		'users',
		'sessions',
		'favorites',
		'subscriptions',
		'collections',
		'collection_documents',
		'notifications',
		'proposals',
		'document_reviews',
		'discussions',
		'upload_jobs',
		'document_sources'
	]) {
		assert.equal(
			counts[name],
			0,
			`Populated legacy ${name} needs a reviewed mapping before upgrade.`
		);
	}
	assert.ok(counts.documents > 0 && counts.schema_migrations === 13);
	assert.equal(
		Number(
			(
				await tx`SELECT count(*) AS n FROM ${tx(`${source}.documents`)} WHERE owner_id IS NOT NULL OR reviewed_at IS NOT NULL OR reviewed_by IS NOT NULL OR next_review_at IS NOT NULL OR merged_into IS NOT NULL OR source_note<>''`
			)[0].n
		),
		0,
		'Legacy lifecycle/source notes require explicit mapping.'
	);
	return { source, tables, columns, sequences, foreignKeys, functions, views, triggers, counts };
}

export async function cloneLegacySchema(tx, snapshot, schema) {
	const { source, tables, columns, sequences, foreignKeys, functions, views, triggers } = snapshot;
	await tx`CREATE SCHEMA ${tx(schema)}`;
	await tx.unsafe(`SET LOCAL search_path TO ${identifier(schema)}`);
	assert.equal((await tx`SELECT current_schema() AS name`)[0].name, schema);
	for (const table of tables) {
		await tx`CREATE TABLE ${tx(`${schema}.${table.name}`)} (LIKE ${tx(`${source}.${table.name}`)} INCLUDING CONSTRAINTS INCLUDING INDEXES)`;
		await tx`INSERT INTO ${tx(`${schema}.${table.name}`)} SELECT * FROM ${tx(`${source}.${table.name}`)}`;
	}
	// LIKE INCLUDING DEFAULTS would share public serial sequences. Recreate
	// those defaults explicitly, with private sequences and original counters.
	for (const sequence of sequences) {
		for (const field of ['start_value', 'min_value', 'max_value', 'increment_by', 'cache_size'])
			assert.match(sequence[field], /^-?\d+$/);
		const [counter] =
			await tx`SELECT last_value::text,is_called FROM ${tx(`${source}.${sequence.name}`)}`;
		await tx.unsafe(
			`CREATE SEQUENCE ${identifier(sequence.name)} INCREMENT BY ${sequence.increment_by} MINVALUE ${sequence.min_value} MAXVALUE ${sequence.max_value} START WITH ${sequence.start_value} CACHE ${sequence.cache_size} ${sequence.cycle ? 'CYCLE' : 'NO CYCLE'}`
		);
		await tx`SELECT setval(${`${schema}.${sequence.name}`}::regclass,${counter.last_value}::bigint,${counter.is_called})`;
	}
	for (const column of columns.filter((c) => c.column_default)) {
		const table = identifier(column.table_name),
			name = identifier(column.column_name);
		const sequence = column.column_default.match(/^nextval\('([a-z0-9_]+)'::regclass\)$/);
		if (sequence) {
			const seq = sequence[1];
			assert.ok(
				sequences.some((item) => item.name === seq),
				'Unknown source sequence.'
			);
			await tx.unsafe(`ALTER SEQUENCE ${identifier(seq)} OWNED BY ${table}.${name}`);
			await tx.unsafe(
				`ALTER TABLE ${table} ALTER COLUMN ${name} SET DEFAULT nextval(${quote(`${schema}.${seq}`)}::regclass)`
			);
		} else {
			assert.ok(
				!column.column_default.includes('nextval'),
				'Unknown serial default must not reference the source.'
			);
			await tx.unsafe(
				`ALTER TABLE ${table} ALTER COLUMN ${name} SET DEFAULT ${column.column_default}`
			);
		}
	}
	for (const fk of foreignKeys) {
		assert.ok(!fk.definition.includes(`${source}.`), 'Foreign keys must stay inside the copy.');
		await tx.unsafe(
			`ALTER TABLE ${identifier(fk.table_name)} ADD CONSTRAINT ${identifier(fk.name)} ${fk.definition}`
		);
	}
	for (const fn of functions) {
		const definition = fn.definition.replace(
			/^CREATE OR REPLACE FUNCTION [a-z_][a-z0-9_]*\./,
			`CREATE OR REPLACE FUNCTION ${identifier(schema)}.`
		);
		assert.ok(
			!definition.includes(`${source}.`),
			'A legacy function explicitly references the source schema.'
		);
		await tx.unsafe(definition);
	}
	for (const view of views) {
		assert.ok(
			!view.definition.includes(`${source}.`),
			'A legacy view references the source schema.'
		);
		await tx.unsafe(`CREATE VIEW ${identifier(view.name)} AS ${view.definition}`);
	}
	for (const trigger of triggers) {
		const definition = trigger.definition.replaceAll(`${source}.`, `${identifier(schema)}.`);
		await tx.unsafe(definition);
		const mode = { O: 'ENABLE', D: 'DISABLE', R: 'ENABLE REPLICA', A: 'ENABLE ALWAYS' }[
			trigger.enabled
		];
		assert.ok(mode, 'Unknown trigger state.');
		await tx.unsafe(
			`ALTER TABLE ${identifier(trigger.table_name)} ${mode} TRIGGER ${identifier(trigger.name)}`
		);
	}
	const sourceDependencies =
		await tx`SELECT count(*) AS n FROM pg_attrdef d JOIN pg_class c ON c.oid=d.adrelid JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schema} AND pg_get_expr(d.adbin,d.adrelid) LIKE ${`%${source}.%`}`;
	assert.equal(Number(sourceDependencies[0].n), 0, 'Copied defaults reference the source schema.');
	assert.equal(
		Number(
			(
				await tx`SELECT count(*) AS n FROM pg_constraint fk JOIN pg_class c ON c.oid=fk.conrelid JOIN pg_namespace own ON own.oid=c.relnamespace JOIN pg_class referenced ON referenced.oid=fk.confrelid JOIN pg_namespace other ON other.oid=referenced.relnamespace WHERE fk.contype='f' AND own.nspname=${schema} AND other.nspname<>${schema}`
			)[0].n
		),
		0,
		'A copied foreign key points outside the copy.'
	);
}

export async function upgradeLegacySchema(tx, snapshot, reference) {
	const { source, tables, columns, triggers } = snapshot;
	assert.notEqual(source, reference);
	await tx`SELECT set_config('search_path',${source},true)`;
	assert.equal((await tx`SELECT current_schema() AS name`)[0].name, source);
	for (const trigger of triggers) {
		await tx.unsafe(
			`ALTER TABLE ${identifier(trigger.table_name)} DISABLE TRIGGER ${identifier(trigger.name)}`
		);
	}
	await tx`ALTER TABLE revisions RENAME COLUMN actor_id TO legacy_actor_id`;
	await tx`ALTER TABLE discussions RENAME COLUMN status TO legacy_status`;
	const applied = await applyMigrations(tx);
	// Check every original field before introducing any intentional mapping.
	for (const table of tables) {
		const names = columns.filter((c) => c.table_name === table.name).map((c) => c.column_name);
		const source = names.map(identifier).join(',');
		const target = names
			.map((name) =>
				identifier(
					table.name === 'revisions' && name === 'actor_id'
						? 'legacy_actor_id'
						: table.name === 'discussions' && name === 'status'
							? 'legacy_status'
							: name
				)
			)
			.join(',');
		const [difference] = await tx.unsafe(
			`SELECT count(*) AS n FROM ((SELECT ${source} FROM ${identifier(reference)}.${identifier(table.name)} EXCEPT ALL SELECT ${target} FROM ${identifier(table.name)}) UNION ALL (SELECT ${target} FROM ${identifier(table.name)} ${table.name === 'schema_migrations' ? `WHERE name IN(SELECT name FROM ${identifier(reference)}.schema_migrations)` : ''} EXCEPT ALL SELECT ${source} FROM ${identifier(reference)}.${identifier(table.name)})) difference`
		);
		assert.equal(Number(difference.n), 0, `Original ${table.name} data changed.`);
	}
	// Preserve legacy classification verbatim as metadata while mapping the
	// application's equivalent field names. Never erase the original field.
	await tx`ALTER TABLE documents ADD COLUMN legacy_field TEXT`;
	await tx`UPDATE documents SET legacy_field=field,field=CASE category WHEN '업무 절차' THEN '절차' WHEN '위키 안내' THEN '일반' WHEN '일반 지식' THEN '일반' WHEN '' THEN field ELSE category END`;
	await tx`INSERT INTO wv_document_tags(document_id,tag) SELECT document_id,tag FROM document_tags UNION SELECT id,unnest(tags) FROM documents ON CONFLICT DO NOTHING`;
	// A legacy snapshot did not capture historical source relations. Keep
	// its real metadata for reading/comparison, but do not advertise v3 full
	// restoration by inventing missing sourceIds or historical permissions.
	await tx`UPDATE revisions SET document_state=jsonb_build_object('stateVersion',2,'title',snapshot->'title','slug',snapshot->'slug','field',CASE snapshot->>'category' WHEN '업무 절차' THEN '절차' WHEN '위키 안내' THEN '일반' WHEN '일반 지식' THEN '일반' WHEN '' THEN snapshot->>'field' ELSE COALESCE(snapshot->>'category',snapshot->>'field') END,'description',snapshot->'description','sourceName',snapshot->'source_name','governance',snapshot->'governance','aliases',snapshot->'aliases','tags',snapshot->'tags','deletedAt',snapshot->'deleted_at','deletedBy',snapshot->'deleted_by','mergedInto',snapshot->'merged_into','legacyCategory',snapshot->'category','legacySourceNote',snapshot->'source_note') WHERE jsonb_typeof(snapshot)='object'`;
	assert.equal(
		Number(
			(
				await tx`SELECT count(*) AS n FROM ${tx(`${reference}.documents`)} original JOIN documents copy USING(id) WHERE (to_jsonb(copy)->'content') IS DISTINCT FROM (to_jsonb(original)->'content') OR copy.updated_at IS DISTINCT FROM original.updated_at OR copy.slug IS DISTINCT FROM original.slug OR copy.legacy_field IS DISTINCT FROM original.field OR copy.category IS DISTINCT FROM original.category`
			)[0].n
		),
		0,
		'Mapping changed original content, address, version or classification.'
	);
	assert.equal(
		Number(
			(
				await tx`SELECT count(*) AS n FROM revisions WHERE (snapshot IS NULL) IS DISTINCT FROM (document_state IS NULL)`
			)[0].n
		),
		0
	);
	assert.equal(
		Number(
			(
				await tx`SELECT count(*) AS n FROM revisions WHERE snapshot IS NOT NULL AND (snapshot->'title' IS DISTINCT FROM document_state->'title' OR snapshot->'aliases' IS DISTINCT FROM document_state->'aliases')`
			)[0].n
		),
		0
	);
	const [routes] =
		await tx`SELECT count(*) AS n FROM ${tx(`${reference}.redirects`)} old WHERE NOT EXISTS(SELECT 1 FROM wv_resolved_names current WHERE current.alias_slug=old.alias_slug AND current.document_id=old.document_id)`;
	assert.equal(Number(routes.n), 0, 'Existing alias destinations changed.');
	const [search] =
		await tx`SELECT wv_search_documents_v1('{"q":"","terms":[],"limit":40}'::jsonb) AS result`;
	const [expected] =
		await tx`SELECT count(*)::int AS n FROM ${tx(`${reference}.documents`)} WHERE deleted_at IS NULL`;
	assert.equal(Number(search.result.total), expected.n);
	return applied;
}

export async function applyLegacyUpgrade(tx, source, backup) {
	identifier(source);
	assert.match(backup, /^wiki_(backup|test)_legacy_[a-z0-9_]+$/);
	await tx`SET LOCAL lock_timeout='5s'`;
	await tx`SET LOCAL statement_timeout='5min'`;
	await tx`SET LOCAL idle_in_transaction_session_timeout='60s'`;
	await tx`SELECT pg_advisory_xact_lock(21470921,1)`;
	await tx`SELECT set_config('search_path',${source},true)`;
	assert.equal((await tx`SELECT current_schema() AS name`)[0].name, source);
	const [previous] = await tx`SELECT to_regclass(${`${source}.wv_legacy_upgrade`})::text AS name`;
	if (previous.name) {
		const [row] = await tx`SELECT report FROM wv_legacy_upgrade WHERE id=1`;
		assert.ok(row, 'Legacy upgrade marker is incomplete.');
		const applied = await applyMigrations(tx);
		return { ...row.report, alreadyApplied: true, newlyAppliedMigrations: applied };
	}
	const tables =
		await tx`SELECT tablename AS name FROM pg_tables WHERE schemaname=${source} ORDER BY tablename`;
	assert.ok(
		tables.some((table) => table.name === 'documents'),
		'Legacy documents are missing.'
	);
	await tx.unsafe(
		`LOCK TABLE ${tables.map(({ name }) => `${identifier(source)}.${identifier(name)}`).join(',')} IN ACCESS EXCLUSIVE MODE`
	);
	const snapshot = await readLegacySnapshot(tx, source);
	console.log('Preserving legacy rows, sequences, functions, views and triggers.');
	await cloneLegacySchema(tx, snapshot, backup);
	console.log('Applying the upgrade and comparing original data with its preserved copy.');
	const applied = await upgradeLegacySchema(tx, snapshot, backup);
	const report = {
		measuredAt: new Date().toISOString(),
		source,
		backup,
		sourceCounts: snapshot.counts,
		appliedMigrations: applied,
		legacyObjects: {
			functions: snapshot.functions.length,
			views: snapshot.views.length,
			retiredTriggers: snapshot.triggers.length,
			sequences: snapshot.sequences.length
		},
		checks: [
			'Every original row and column compared against a separate preserved copy',
			'Document IDs, bodies, timestamps, alias destinations and original revision snapshots preserved',
			'Original classification retained alongside the mapped field',
			'Past metadata missing from snapshots is not invented',
			'Backup sequence counters, foreign keys, functions, views and trigger states are independent',
			'Previous migration checksums remain unchanged'
		],
		limitations: [
			'Populated legacy accounts, uploads, collaboration or lifecycle fields require additional mappings',
			'Historical snapshots are not complete v3 snapshots'
		],
		passed: true
	};
	await tx`CREATE TABLE wv_legacy_upgrade(id INTEGER PRIMARY KEY CHECK(id=1),report JSONB NOT NULL)`;
	await tx`INSERT INTO wv_legacy_upgrade(id,report) VALUES(1,${tx.json(report)})`;
	return report;
}
