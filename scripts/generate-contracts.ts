import { writeFile } from 'node:fs/promises';
import { z } from 'zod';
import { runtimeStateSchema } from '../src/shared/protocol';
import { metadataRecordSchema, metadataStateSchema } from '../src/shared/metadata';
import { candidateSchema, entryInputSchema, entryImageSaveSchema, subscriptionsStateSchema, xSyncStateSchema } from '../src/shared/subscriptions';
import { preferencesSchema } from '../src/shared/preferences';
import { savedWorkSchema } from '../src/shared/library';
import { magnetResultSchema } from '../src/shared/magnets';
import { diagnosticEntrySchema } from '../src/shared/diagnostics';
import { subscriptionFailureContextSchema } from '../src/shared/subscription-failure';

const schemas = {
	diagnostic: diagnosticEntrySchema,
	failureContext: subscriptionFailureContextSchema,
	xSync: xSyncStateSchema,
	magnet: magnetResultSchema,
	runtime: runtimeStateSchema,
	record: metadataRecordSchema,
	metadata: metadataStateSchema,
	candidate: candidateSchema,
	entry: entryInputSchema,
	imageSave: entryImageSaveSchema,
	subscriptions: subscriptionsStateSchema,
	preferences: preferencesSchema,
	work: savedWorkSchema,
};
const contracts = Object.fromEntries(Object.entries(schemas).map(([key, schema]) => [key, z.toJSONSchema(schema, { io: 'input' })]));
await writeFile(new URL('../src-tauri/resources/contracts.json', import.meta.url), JSON.stringify(contracts, null, '\t') + '\n');
