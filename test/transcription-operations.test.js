import assert from 'node:assert/strict';
import test from 'node:test';
process.env.OPENAI_API_KEY ||= 'test-key';
process.env.TRANSCRIPTION_OPERATIONS_ENABLED = 'true';
process.env.SUPABASE_URL ||= 'https://example.supabase.co';
process.env.SUPABASE_ANON_KEY ||= 'test-key';
process.env.SUPABASE_SERVICE_ROLE_KEY ||= 'test-key';
const { createTranscriptionOperations, createTranscriptionOperationFailureTimingLog, operationPayloadHash, sha256 } = await import('../src/services/transcription-operations.js');
const { classifyOperationResponse, canSubmitOperation, readPendingOperation, pendingOperationStorageKey } = await import('../client/src/utils/transcription-operation.js');
const user='a8b1dc79-6f44-4a9d-9e7e-0c0f0f6a9de1', id='b8b1dc79-6f44-4a9d-9e7e-0c0f0f6a9de1';
function fixture(options={}) {
  const buffer=Buffer.from('synthetic-audio');
  const operation={id,user_id:user,status:'queued',filename:'fixture.wav',requested_language:'ko',byte_size:buffer.length,payload_hash:operationPayloadHash(buffer,'ko'),duration_seconds:120,credits_reserved:2,attempt_count:0,
    storage_manifest:[{path:`${user}/${id}/0000`,bytes:buffer.length,sha256:sha256(buffer)}]};
  const calls=[],removed=[],uploads=[],diagnosticUpdates=[];let providerCalls=0,finalizations=0,checkpointCalls=0;
  const bucket={upload:async(path,data)=>{uploads.push({path,data});return {}},download:async()=>({data:new Blob([buffer])}),list:async()=>({data:[{id:'object',name:'0000'}]}),remove:async paths=>{removed.push(...paths);return options.removeError?{error:Error('storage unavailable')}:{}}};
  const database={storage:{from:()=>bucket},from(table){const filters={};let update;const query={select(){return this},eq(k,v){filters[k]=v;return this},update(v){update=v;return this},maybeSingle:async()=>({data:(!filters.user_id||filters.user_id===user)?{...operation}:null}),single:async()=>({data:{credits:98}}),then(resolve){
    if(update?.timings){calls.push('update_transcription_operation_timings');diagnosticUpdates.push(update.timings);const error=options.diagnosticUpdateError?Error('diagnostic storage unavailable'):null;if(!error&&(!filters.status||filters.status===operation.status)&&(!filters.worker_token||filters.worker_token===operation.worker_token))Object.assign(operation,update);return Promise.resolve({data:null,error}).then(resolve)}
    if(update)Object.assign(operation,update);return Promise.resolve({data:null,error:null}).then(resolve)}};return query},async rpc(name,p){calls.push(name);
    if(name==='claim_transcription_operation'){if(!['queued','finalizing'].includes(operation.status))return {data:[]};operation.status=operation.checkpoint_segments?'finalizing':'running';operation.worker_token=p.p_worker_token;operation.attempt_count++;return {data:[{...operation}]}}
    if(name==='checkpoint_transcription_operation'){checkpointCalls++;if(options.checkpointUnavailable)return {error:Error('database unavailable')};if(operation.status!=='running')return {data:false};Object.assign(operation,{status:'finalizing',checkpoint_segments:p.p_segments});if(options.checkpointResponseLost&&checkpointCalls===1)return {error:Error('response lost')};return {data:true}}
    if(name==='finalize_transcription_operation'){if(options.finalizeUnavailable)return {error:Error('database unavailable')};if(operation.status!=='finalizing')return {data:[{completed:false}]};operation.status='completed';finalizations++;if(options.finalizeResponseLost&&finalizations===1)return {error:Error('response lost')};return {data:[{completed:true}]}}
    if(name==='release_transcription_operation_lease'){if(['running','finalizing'].includes(operation.status))operation.status='queued';return {data:true}}
    if(name==='fail_transcription_operation'){operation.status='failed';return {data:[{updated:true,credits_restored:2}]}}
    if(name==='cancel_transcription_operation'){operation.status='cancelled';return {data:[{updated:true,credits_restored:2}]}}
    if(name==='create_transcription_operation')return {data:[{operation_id:id,status:options.enqueueExisting?'queued':'staged'}]};
    if(name==='queue_transcription_operation'){operation.status='queued';return options.queueResponseLost?{error:Error('response lost')}:{data:[{operation_id:id,status:'queued'}]}}
    return {data:true};
  }};
  const service=createTranscriptionOperations({database,retryDelay:0,transcribeAudio:async(...args)=>{providerCalls++;return options.transcribe?options.transcribe(...args):{segments:[{text:'test',start:0,end:1}],language:'ko'}},processSegments:async segments=>({segments}),probe:async()=>120});
  return {service,operation,calls,removed,uploads,diagnosticUpdates,options,buffer,providerCalls:()=>providerCalls,finalizations:()=>finalizations};
}
function maintenanceFixture({operations=[], owners=[], files={}, listErrors={}, removeError, updateError, existenceError}={}) {
  const rows=operations.map(operation=>({...operation})), selectCalls=[], lists=[], removed=[], updates=[];
  const failureState={listErrors:{...listErrors},removeError,updateError,existenceError};
  const bucket={
    async list(prefix,options={}) { if(prefix)lists.push(prefix); if(failureState.listErrors[prefix])return {error:Error('list failed')};
      if(prefix==='')return {data:owners.map(name=>({name}))};
      if(rows.some(row=>`${row.user_id}/${row.id}`===prefix))return {data:files[prefix]||[]};
      const owner=owners.find(name=>name===prefix); if(owner)return {data:(files[owner]||[]).map(({name})=>({name}))};
      return {data:files[prefix]||[]};
    },
    async remove(paths) { removed.push(...paths); return failureState.removeError?{error:Error('remove failed')}:{data:paths.map(path=>({name:path.split('/').at(-1)}))}; },
  };
  const database={storage:{from:()=>bucket},from(table) {
    const filters=[], selections={fields:'*'}, sorts=[], query={
      select(fields='*'){selections.fields=fields;return this;},
      eq(key,value){filters.push(row=>row[key]===value);return this;},
      is(key,value){filters.push(row=>row[key]===value);return this;},
      in(key,values){filters.push(row=>values.includes(row[key]));return this;},
      lt(key,value){filters.push(row=>row[key]<value);return this;},
      order(key,options){sorts.push({key,...options});return this;},
      limit(value){selections.limit=value;return this;},
      update(values){selections.update=values;return this;},
      async maybeSingle(){
        if(table!=='transcription_operations')return {data:null};
        const candidates=rows.filter(row=>filters.every(filter=>filter(row)));
        if(failureState.existenceError&&selections.fields==='id')return {error:Error('existence lookup failed')};
        return {data:candidates[0]?{id:candidates[0].id}:null};
      },
      then(resolve,reject) {
        if(table!=='transcription_operations')return Promise.resolve({data:null,error:null}).then(resolve,reject);
        if(selections.update) {
          if(Object.hasOwn(selections.update,'audio_deleted_at'))updates.push({fields:selections.update,filters:selections.fields});
          if(failureState.updateError&&Object.hasOwn(selections.update,'audio_deleted_at'))return Promise.resolve({data:null,error:Error('update failed')}).then(resolve,reject);
          for(const row of rows)if(filters.every(filter=>filter(row)))Object.assign(row,selections.update);
          return Promise.resolve({data:null,error:null}).then(resolve,reject);
        }
        if(selections.fields==='id,user_id,status,audio_deleted_at')selectCalls.push({fields:selections.fields,filters:filters.length,limit:selections.limit,order:sorts.map(({key,ascending,nullsFirst})=>({key,ascending,nullsFirst}))});
        let data=rows.filter(row=>filters.every(filter=>filter(row)));
        for(const {key,ascending=true,nullsFirst=false} of sorts)data=data.sort((a,b)=>{
          const av=a[key],bv=b[key]; if(av==null||bv==null)return av==null?(bv==null?0:(nullsFirst?-1:1)):(nullsFirst?1:-1);
          const compared=av<bv?-1:av>bv?1:0;return ascending?compared:-compared;
        });
        if(selections.limit!==undefined)data=data.slice(0,selections.limit);
        const fields=selections.fields==='*'?null:selections.fields.split(',');
        return Promise.resolve({data:fields?data.map(row=>Object.fromEntries(fields.map(field=>[field,row[field]]))):data,error:null}).then(resolve,reject);
      },
    };
    return query;
  },async rpc(name){if(name==='cancel_transcription_operation')return {data:[{updated:true}]};return {data:true};}};
  return {service:createTranscriptionOperations({database}),rows,selectCalls,lists,removed,updates,failureState};
}

test('maintenance excludes already cleaned terminal operations and requests only cleanup fields',async()=>{
  const f=maintenanceFixture({operations:[{id,user_id:user,status:'completed',audio_deleted_at:'2026-01-01'}],owners:[]});
  await f.service.maintenance();
  const terminalQuery=f.selectCalls.find(call=>call.limit===20);
  assert.deepEqual(terminalQuery,{fields:'id,user_id,status,audio_deleted_at',filters:2,limit:20,order:[{key:'audio_deleted_at',ascending:true,nullsFirst:true}]});
  assert.deepEqual(f.lists,[]);assert.deepEqual(f.removed,[]);assert.deepEqual(f.updates,[]);
});

test('maintenance cleans a new terminal operation and marks audio deleted',async()=>{
  const prefix=`${user}/${id}`,f=maintenanceFixture({operations:[{id,user_id:user,status:'completed',audio_deleted_at:null}],owners:[],files:{[prefix]:[{id:'object',name:'0000'}]}});
  await f.service.maintenance();
  assert.deepEqual(f.lists,[prefix]);assert.deepEqual(f.removed,[`${prefix}/0000`]);assert.equal(f.rows[0].audio_deleted_at!==null,true);
  assert.equal(f.updates.filter(update=>update.fields.audio_deleted_at).length,1);
});

test('maintenance retries storage listing, removal, and database update failures',async()=>{
  const prefix=`${user}/${id}`;
  for(const failure of ['list','remove','update']) {
    const f=maintenanceFixture({operations:[{id,user_id:user,status:'failed',audio_deleted_at:null}],owners:[],files:{[prefix]:[{id:'object',name:'0000'}]},listErrors:failure==='list'?{[prefix]:true}:{},removeError:failure==='remove',updateError:failure==='update'});
    await assert.rejects(()=>f.service.maintenance());assert.equal(f.rows[0].audio_deleted_at,null);
    if(failure==='list')assert.deepEqual(f.removed,[]);
    if(failure==='remove')assert.deepEqual(f.updates,[]);
    if(failure==='update')assert.equal(f.removed.length,1);
    if(failure==='list')delete f.failureState.listErrors[prefix];
    if(failure==='remove')f.failureState.removeError=false;
    if(failure==='update')f.failureState.updateError=false;
    await f.service.maintenance();assert.ok(f.rows[0].audio_deleted_at);
  }
});

test('maintenance preserves staged, queued, and running operations',async()=>{
  const f=maintenanceFixture({operations:['staged','queued','running'].map(status=>({id,user_id:user,status,audio_deleted_at:null,expires_at:'2999-01-01'})),owners:[]});
  await f.service.maintenance();assert.deepEqual(f.lists,[]);assert.deepEqual(f.removed,[]);assert.ok(f.rows.every(row=>row.status!=='cancelled'));
});

test('maintenance applies terminal filters and the twenty row cleanup limit',async()=>{
  const eligible=Array.from({length:22},(_,index)=>({id:`c8b1dc79-6f44-4a9d-9e7e-${String(index+1).padStart(12,'0')}`,user_id:user,status:['completed','failed','cancelled'][index%3],audio_deleted_at:null}));
  const alreadyCleaned={id:'d8b1dc79-6f44-4a9d-9e7e-000000000001',user_id:user,status:'completed',audio_deleted_at:'2026-01-01'};
  const f=maintenanceFixture({operations:[...eligible,alreadyCleaned,{id:'e8b1dc79-6f44-4a9d-9e7e-000000000001',user_id:user,status:'running',audio_deleted_at:null}],owners:[]});
  await f.service.maintenance();
  assert.equal(f.updates.length,20);assert.ok(f.rows.slice(0,20).every(row=>row.audio_deleted_at));
  assert.ok(f.rows.slice(20).every(row=>row.audio_deleted_at===null||row.audio_deleted_at==='2026-01-01'));
  assert.equal(f.selectCalls[0].limit,20);assert.equal(f.selectCalls[0].filters,2);
});

test('orphan cleanup preserves existing operations and removes only old files for missing operations',async()=>{
  const existing='c8b1dc79-6f44-4a9d-9e7e-0c0f0f6a9de1',missing='d8b1dc79-6f44-4a9d-9e7e-0c0f0f6a9de1',old='2020-01-01T00:00:00.000Z',recent=new Date().toISOString();
  const existingPrefix=`${user}/${existing}`,missingPrefix=`${user}/${missing}`;
  const f=maintenanceFixture({operations:[{id:existing,user_id:user,status:'completed',audio_deleted_at:'2026-01-01'}],owners:[user],files:{[user]:[{name:existing},{name:missing}],[existingPrefix]:[{id:'kept',name:'0000',created_at:old}],[missingPrefix]:[{id:'old',name:'0000',created_at:old},{id:'new',name:'0001',created_at:recent}]}});
  await f.service.maintenance();assert.deepEqual(f.removed,[`${missingPrefix}/0000`]);
});

test('orphan cleanup stops when operation existence cannot be determined',async()=>{
  const missing='d8b1dc79-6f44-4a9d-9e7e-0c0f0f6a9de1';
  const f=maintenanceFixture({owners:[user],files:{[user]:[{name:missing}]},existenceError:true});
  await assert.rejects(()=>f.service.maintenance(),/existence lookup failed/);assert.deepEqual(f.removed,[]);
});

test('lost checkpoint and finalize responses do not cause refunds, deletion, or duplicate provider work',async()=>{const f=fixture({checkpointResponseLost:true,finalizeResponseLost:true});await f.service.processNext();assert.equal(f.operation.status,'completed');assert.equal(f.providerCalls(),1);assert.equal(f.finalizations(),1);assert.ok(!f.calls.includes('fail_transcription_operation'));assert.deepEqual(f.removed,[])});
test('finalize outage resumes from saved checkpoint without retranscribing',async()=>{const f=fixture({finalizeUnavailable:true});await f.service.processNext();assert.equal(f.operation.status,'queued');assert.ok(f.operation.checkpoint_segments);f.options.finalizeUnavailable=false;await f.service.processNext();assert.equal(f.operation.status,'completed');assert.equal(f.providerCalls(),1)});
test('uncertain checkpoint never refunds or deletes potentially committed work',async()=>{const f=fixture({checkpointUnavailable:true});await f.service.processNext();assert.equal(f.operation.status,'queued');assert.ok(!f.calls.includes('fail_transcription_operation'));assert.deepEqual(f.removed,[])});
test('provider failure refunds first and then stores sanitized ordinary diagnostics', async () => {
  const error = Object.assign(Error('private provider detail'), {
    code: 'TIMEOUT',
    providerErrorType: 'APIConnectionTimeoutError',
    timings: {
      splitMs: 120,
      openaiMs: 600_100,
      chunkCount: 4,
      failedChunk: {
        index: 2,
        inputStartSeconds: 355,
        inputEndSeconds: 545,
        openaiMs: 600_000,
        openaiAttempts: [{
          phase: 'initial',
          outcome: 'error',
          durationMs: 600_000,
          clientRequestId: '7a2d41de-8f08-49c7-8f88-cf704494fc86',
          maxRetries: 4,
        }],
      },
      completedChunkTimings: [{ index: 0, openaiMs: 24_000 }],
    },
  });
  const f = fixture({ transcribe: async () => { throw error; } });

  await f.service.processNext();

  assert.equal(f.operation.status, 'failed');
  assert.equal(f.calls.filter(name => name === 'fail_transcription_operation').length, 1);
  assert.ok(f.calls.indexOf('fail_transcription_operation') < f.calls.indexOf('update_transcription_operation_timings'));
  assert.equal(f.diagnosticUpdates.length, 1);
  assert.equal(f.operation.timings.mode, 'ordinary');
  assert.equal(f.operation.timings.error.code, 'TIMEOUT');
  assert.equal(f.operation.timings.error.type, 'APIConnectionTimeoutError');
  assert.equal(f.operation.timings.provider.failedChunk.index, 2);
  assert.equal(f.operation.timings.failureRecorded, true);
  assert.equal(f.operation.timings.creditsRestored, 2);
  assert.ok(!JSON.stringify(f.operation.timings).includes('private provider detail'));
  assert.ok(Buffer.byteLength(JSON.stringify(f.operation.timings)) <= 32 * 1024);
});

test('diagnostic storage failure cannot undo a completed failure refund', async () => {
  const f = fixture({
    diagnosticUpdateError: true,
    transcribe: async () => {
      throw Object.assign(Error('provider unavailable'), {
        code: 'CONNECTION',
        timings: { openaiMs: 500 },
      });
    },
  });

  await f.service.processNext();

  assert.equal(f.operation.status, 'failed');
  assert.equal(f.calls.filter(name => name === 'fail_transcription_operation').length, 1);
  assert.equal(f.diagnosticUpdates.length, 1);
  assert.equal(f.operation.timings, undefined);
});

test('failure diagnostics are bounded even when provider arrays are unexpectedly large', () => {
  const attempt = {
    phase: 'initial',
    outcome: 'error',
    durationMs: 600_000,
    clientRequestId: 'a'.repeat(200),
    requestId: 'b'.repeat(200),
    maxRetries: 4,
  };
  const chunks = Array.from({ length: 100 }, (_, index) => ({
    index,
    openaiMs: 600_000,
    openaiAttempts: Array.from({ length: 100 }, () => attempt),
  }));
  const log = createTranscriptionOperationFailureTimingLog({
    operation: { id, attempt_count: 1, duration_seconds: 720 },
    error: Object.assign(Error('must not persist'), {
      code: 'TIMEOUT',
      timings: { chunkCount: 100, completedChunkTimings: chunks },
    }),
    startedAt: 1_000,
    completedAt: 601_000,
    failureResult: { updated: true, credits_restored: 12 },
  });

  assert.ok(Buffer.byteLength(JSON.stringify(log)) <= 32 * 1024);
  assert.equal(log.provider.diagnosticTruncated, true);
  assert.ok(!JSON.stringify(log).includes('must not persist'));
});
test('queue response loss retains deterministic audio parts for the successful request',async()=>{const f=fixture({queueResponseLost:true});await assert.rejects(()=>f.service.enqueue({userId:user,operationKey:id,buffer:f.buffer,filename:'fixture.wav',language:'ko'}));assert.equal(f.operation.status,'queued');assert.deepEqual(f.removed,[])});
test('same accepted operation returns without uploading source again',async()=>{const f=fixture({enqueueExisting:true});await f.service.enqueue({userId:user,operationKey:id,buffer:f.buffer,filename:'fixture.wav',language:'ko'});assert.equal(f.uploads.length,0)});
test('large source splits into bounded original-byte parts without reencoding',async()=>{const f=fixture();const buffer=Buffer.alloc(41*1024*1024,7);await f.service.enqueue({userId:user,operationKey:id,buffer,filename:'fixture.wav',language:'ko'});assert.equal(f.uploads.length,2);assert.equal(f.uploads[0].data.length,40*1024*1024);assert.deepEqual(Buffer.concat(f.uploads.map(p=>p.data)),buffer)});
test('active cancellation aborts provider and cannot checkpoint or charge',async()=>{let entered;const ready=new Promise(r=>entered=r);const f=fixture({transcribe:async(b,n,l,{signal})=>{entered();return new Promise((r,reject)=>signal.addEventListener('abort',()=>reject(Error('aborted')),{once:true}))}});const work=f.service.processNext();await ready;await f.service.cancel(id,user);await work;assert.equal(f.operation.status,'cancelled');assert.equal(f.finalizations(),0);assert.ok(!f.calls.includes('checkpoint_transcription_operation'))});
test('failed audio cleanup is not marked deleted and can be retried',async()=>{const f=fixture({removeError:true});f.operation.status='completed';await assert.rejects(()=>f.service.cleanAudio(f.operation));assert.equal(f.operation.audio_deleted_at,undefined);f.options.removeError=false;await f.service.cleanAudio(f.operation);assert.ok(f.operation.audio_deleted_at)});
test('another user cannot retrieve an operation',async()=>{const f=fixture();assert.equal(await f.service.getForUser(id,'other-user'),null)});
test('response classification separates login, missing, temporary failure and terminal states',()=>{assert.equal(classifyOperationResponse(401,{}),'login');assert.equal(classifyOperationResponse(404,{}),'missing');assert.equal(classifyOperationResponse(503,{}),'retry');assert.equal(classifyOperationResponse(200,{status:'finalizing'}),'active');assert.equal(classifyOperationResponse(200,{status:'cancelled'}),'terminal')});
test('saved keys are isolated by account and corrupted storage is safe',()=>{const values=new Map([[pendingOperationStorageKey(user),JSON.stringify({operationKey:id})]]);const storage={getItem:k=>values.get(k)};assert.equal(readPendingOperation(storage,user).operationKey,id);assert.equal(readPendingOperation(storage,'other'),null);assert.equal(readPendingOperation({getItem:()=>{throw Error('denied')}},user),null)});

test('pending ordinary work cannot turn same-operation retry into separately billed diarization',()=>{assert.equal(canSubmitOperation({operationKey:id},true),false);assert.equal(canSubmitOperation({operationKey:id},false),true);assert.equal(canSubmitOperation(null,true),true)});
