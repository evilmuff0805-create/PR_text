const fs=require('fs');const {Client}=require(process.env.PG_CLIENT_PATH || 'pg');const path=require('path');const base=fs.readFileSync(path.join(__dirname,'baseline.sql'),'utf8');
const config={host:process.env.PGHOST || '127.0.0.1',port:Number(process.env.PGPORT || 55432),user:process.env.PGUSER || 'fixture',password:process.env.PGPASSWORD,database:'postgres'};
async function boot(){
 const admin=new Client(config);await admin.connect();
 for(const role of ['anon','authenticated','service_role']) await admin.query(`do $$ begin create role ${role} ${role==='service_role'?'bypassrls':''};exception when duplicate_object then null; end $$`);
 const name='fixture_'+Date.now();await admin.query(`create database ${name}`);
 const client=new Client({...config,database:name});await client.connect();client.exec=s=>client.query(s);
 await client.exec(base.replace('create role anon; create role authenticated; create role service_role bypassrls;',''));
 const dir=path.join(__dirname,'../../supabase/migrations');for(const file of fs.readdirSync(dir).filter(f=>f.endsWith('.sql')).sort()){try{await client.exec(fs.readFileSync(dir+'/'+file,'utf8'));}catch(e){console.error('migration',file);throw e}}
 client.peer=async()=>{const c=new Client({...config,database:name});await c.connect();return c};
 client.close=async()=>{await client.end();await admin.query(`drop database ${name}`);await admin.end()};return client;
}module.exports={boot};
