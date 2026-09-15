const {boot}=require('./db-replay.cjs');const assert=require('node:assert/strict');const {randomUUID}=require('crypto');
(async()=>{const db=await boot(); const q=async(s,p=[]) => (await db.query(s,p)).rows;let passed=0;const ok=(name)=>{passed++;console.log('PASS '+name)};
const user=randomUUID(),other=randomUUID(),token=randomUUID(),key=randomUUID(),hash='a'.repeat(64);
await q('insert into profiles(id,credits) values($1,100),($2,100)',[user,other]);await q("insert into credit_lots(user_id,source,granted,available) values($1,'legacy',100,100),($2,'legacy',100,100)",[user,other]);
async function create(k=randomUUID(),u=user,h=hash,duration=120){return (await q('select * from create_transcription_operation($1,$2,$3,$4,$5,$6,$7,$8)',[u,k,h,'fixture.wav','audio/wav',100,'ko',duration]))[0]}
async function queue(id,n=2,u=user){return q('select * from queue_transcription_operation($1,$2,$3,$4)',[id,u,JSON.stringify([{path:u+'/'+id+'/0000',bytes:100,sha256:hash}]),n])}
async function balance(){return (await q('select credits from profiles where id=$1',[user]))[0].credits}
let op=await create(key);assert.equal(op.existing,false);let same=await create(key);assert.equal(same.operation_id,op.operation_id);assert.equal(same.existing,true);ok('stable key reuses staged operation');
await assert.rejects(()=>create(key,user,'b'.repeat(64)),e=>e.code==='TO409');ok('same key different fingerprint rejected');
assert.notEqual((await create(key,other)).operation_id,op.operation_id);ok('keys scoped to user');
await queue(op.operation_id);await queue(op.operation_id);assert.equal(await balance(),98);ok('queue retries reserve once');
await assert.rejects(()=>queue(op.operation_id,2,other),e=>e.code==='TO404');ok('cross-user queue denied');
await db.exec('set role authenticated');await assert.rejects(()=>q('select * from transcription_operations'),e=>e.code==='42501');await assert.rejects(()=>create(),e=>e.code==='42501');await db.exec('reset role');ok('authenticated direct table/RPC denied');
let claimed=(await q('select * from claim_transcription_operation($1)',[token]))[0];assert.equal(claimed.id,op.operation_id);assert.equal((await q('select * from claim_diarization_job($1)',[token])).length,0);ok('ordinary claim isolated from legacy worker');
assert.equal((await q('select checkpoint_transcription_operation($1,$2,$3,$4,$5,$6) as ok',[op.operation_id,randomUUID(),'test','[]','ko','{}']))[0].ok,false);ok('stale worker checkpoint fenced');
await q('select checkpoint_transcription_operation($1,$2,$3,$4,$5,$6)',[op.operation_id,token,'test','[{"text":"test","start":0,"end":1}]','ko','{}']);

// Force a history constraint failure and prove the finalization transaction has no partial effects.
await db.exec("alter table transcription_logs add constraint fixture_reject check (filename <> 'fixture.wav')");
await assert.rejects(()=>q('select * from finalize_transcription_operation($1,$2)',[op.operation_id,token]));
assert.equal((await q('select status from transcription_operations where id=$1',[op.operation_id]))[0].status,'finalizing');
assert.equal((await q("select count(*)::int as n from credit_allocations where user_id=$1 and state='consumed'",[user]))[0].n,0);
await db.exec('alter table transcription_logs drop constraint fixture_reject');ok('history failure leaves reservation and checkpoint intact');
assert.equal((await q('select * from finalize_transcription_operation($1,$2)',[op.operation_id,token]))[0].completed,true);
assert.equal((await q('select * from finalize_transcription_operation($1,$2)',[op.operation_id,token]))[0].completed,false);
assert.equal((await q('select count(*)::int n from transcription_logs where user_id=$1',[user]))[0].n,1);assert.equal(await balance(),98);ok('finalize response-loss retry creates one history and charge');
let cancelled=await create(randomUUID(),user,hash,180);await queue(cancelled.operation_id,3);await q('select * from cancel_transcription_operation($1,$2)',[cancelled.operation_id,user]);await q('select * from cancel_transcription_operation($1,$2)',[cancelled.operation_id,user]);assert.equal(await balance(),98);ok('queued cancel restores once');
let recovered=await create();await queue(recovered.operation_id);await q('select * from claim_transcription_operation($1)',[token]);await q("update transcription_operations set locked_at=now()-interval '11 minutes' where id=$1",[recovered.operation_id]);const newToken=randomUUID();assert.equal((await q('select * from claim_transcription_operation($1)',[newToken]))[0].id,recovered.operation_id);
assert.equal((await q('select renew_transcription_operation_lease($1,$2) as ok',[recovered.operation_id,token]))[0].ok,false);ok('stale lease reclaim fences former worker');
await q('select * from fail_transcription_operation($1,$2,$3)',[recovered.operation_id,newToken,'synthetic failure']);await q('select * from fail_transcription_operation($1,$2,$3)',[recovered.operation_id,newToken,'synthetic retry']);assert.equal(await balance(),98);ok('failure releases once');
let insufficient=await create(randomUUID(),user,hash,6060);assert.equal((await queue(insufficient.operation_id,101)).length,0);assert.equal(await balance(),98);ok('insufficient balance leaves no partial reservation');
assert.equal((await q('select count(*)::int n from credit_lots where available<0 or reserved<0 or available+reserved>granted'))[0].n,0);ok('ledger invariants hold');

const paidUser=randomUUID(),order='fixture-'+randomUUID();
await q('insert into profiles(id,credits) values($1,20)',[paidUser]);
await q("insert into payment_orders(order_id,user_id,plan_id,plan_name,amount,credits,status) values($1,$2,'fixture','fixture',1000,20,'paid')",[order,paidUser]);
await q("insert into credit_lots(user_id,source,payment_order_id,granted,available,expires_at) values($1,'payment',$2,20,20,now()+interval '1 hour')",[paidUser,order]);
const exp=await create(randomUUID(),paidUser,hash,180);await queue(exp.operation_id,3,paidUser);
await q("update credit_lots set expires_at=now()-interval '1 second' where user_id=$1",[paidUser]);
await q('select * from cancel_transcription_operation($1,$2)',[exp.operation_id,paidUser]);
assert.equal((await q('select credits from profiles where id=$1',[paidUser]))[0].credits,0);
assert.equal((await q('select available+reserved as total from credit_lots where user_id=$1',[paidUser]))[0].total,0);ok('expiry during reservation does not revive expired minutes');
console.log('TOTAL',passed);await db.close();


})().catch(e=>{console.error('FAIL',e.message,e.code);process.exit(1)});
