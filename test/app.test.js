import { test } from 'node:test';
import assert from 'node:assert/strict';
import { createApp, hashPassword } from '../src/app.js';
import { openDb } from '../src/db.js';

async function fixture(t) {
  const db=openDb(':memory:');
  const mails=[];
  const app=createApp({db,sendVerification:async(email,url)=>mails.push({email,url})});
  const server=app.listen(0,'127.0.0.1');
  await new Promise(resolve=>server.once('listening',resolve));
  t.after(()=>{server.close();db.close();});
  const root=`http://127.0.0.1:${server.address().port}`;
  const client=()=>{
    let cookie='',csrf='';
    return async(path,body,withCsrf=true)=>{
      const response=await fetch(root+path,{method:body?'POST':'GET',redirect:'manual',headers:{cookie,...(body?{'content-type':'application/x-www-form-urlencoded'}:{})},body:body?new URLSearchParams({...body,...(withCsrf?{_csrf:csrf}:{})}):undefined});
      if(response.headers.get('set-cookie')) cookie=response.headers.get('set-cookie').split(';')[0];
      const html=await response.text();
      csrf=html.match(/name="_csrf" value="([^"]+)"/)?.[1]||csrf;
      return {status:response.status,html,location:response.headers.get('location')};
    };
  };
  const seedUser=async(email,department='컴퓨터공학과')=>Number(db.prepare('INSERT INTO users(email,name,department,password,verified) VALUES(?,?,?,?,1)').run(email,'테스트 학생',department,await hashPassword('test-password-123')).lastInsertRowid);
  const login=async c=>{await c('/login');assert.equal((await c('/login',{email:'owner@example.ac.kr',password:'test-password-123'})).status,302);await c('/');};
  return {db,client,seedUser,login,mails};
}

test('학교 도메인 제한, 미인증 로그인 거부, 일회용 인증, 세션 로그인',async t=>{
  const {client,mails}=await fixture(t);const c=client();
  assert.equal((await c('/')).location,'/login');await c('/register');
  const fields={name:'학생',department:'컴퓨터공학과',password:'test-password-123'};
  assert.equal((await c('/register',{...fields,email:'test@outside.com'})).status,400);
  await c('/register');assert.equal((await c('/register',{...fields,email:'test@example.ac.kr'})).status,200);
  await c('/login');assert.equal((await c('/login',{email:'test@example.ac.kr',password:fields.password})).status,403);
  const url=new URL(mails[0].url);assert.equal((await c(url.pathname+url.search)).status,200);
  assert.equal((await c('/verify',{token:url.searchParams.get('token')})).status,200);
  assert.equal((await c('/verify',{token:url.searchParams.get('token')})).status,400);
  await c('/login');assert.equal((await c('/login',{email:'test@example.ac.kr',password:fields.password})).location,'/');
  assert.match((await c('/')).html,/함께할 팀원을/);
});

test('공고 작성 → 지원 → 승인; 정원 초과, 중복, 무권한 승인 및 CSRF 차단',async t=>{
  const {db,client,seedUser,login}=await fixture(t);
  await seedUser('owner@example.ac.kr');await seedUser('first@example.ac.kr');await seedUser('second@example.ac.kr');await seedUser('other@example.ac.kr','경영학과');
  const owner=client();await login(owner);
  const post={title:'캠퍼스 앱 개발 팀 모집',contest:'교내 공모전',description:'테스트할 프로젝트를 함께 만들어볼 팀원을 찾습니다.',deadline:'2099-12-31',quota_0:'1'};
  assert.equal((await owner('/posts',post,false)).status,403);await owner('/posts/new');
  const created=await owner('/posts',post);assert.equal(created.location,'/posts/1');
  await owner('/posts/1');assert.equal((await owner('/posts/1/apply',{motivation:'직접 작성한 공고 지원 차단 테스트',skills:'Express'})).status,400);
  const applicants=[];
  for(const email of ['first@example.ac.kr','second@example.ac.kr','other@example.ac.kr']){
    const c=client();await c('/login');await c('/login',{email,password:'test-password-123'});await c('/posts/1');applicants.push(c);
  }
  const fields={motivation:'웹 서비스를 개발하는 경험을 함께 쌓고 싶습니다.',skills:'Express.js, SQLite'};
  assert.equal((await applicants[2]('/posts/1/apply',fields)).status,409);
  for(const c of applicants.slice(0,2)) assert.equal((await c('/posts/1/apply',fields)).status,302);
  await applicants[0]('/posts/1');assert.equal((await applicants[0]('/posts/1/apply',fields)).status,409);
  assert.equal((await applicants[0]('/applications/1/decision',{status:'approved'})).status,403);
  await owner('/posts/1');assert.match((await owner('/posts/1')).html,/first@example.ac.kr/);
  assert.equal((await owner('/applications/1/decision',{status:'approved'})).status,302);
  assert.match((await owner('/posts/1')).html,/1 / 1명/);
  assert.equal((await owner('/applications/2/decision',{status:'approved'})).status,409);
  assert.equal(db.prepare("SELECT COUNT(*) AS n FROM applications WHERE status='approved'").get().n,1);
  assert.equal((await owner('/applications/1/decision',{status:'approved'})).status,409);
  await owner('/posts/1');assert.equal((await owner('/applications/2/decision',{status:'rejected'})).status,302);
  const visible=await applicants[1]('/posts/1');assert.doesNotMatch(visible.html,/first@example.ac.kr/);assert.match(visible.html,/거절/);
  assert.match((await applicants[0]('/my')).html,/승인/);
});

test('마감된 공고 지원 차단 및 공고 본문 HTML 이스케이프',async t=>{
  const {db,client,seedUser,login}=await fixture(t);await seedUser('owner@example.ac.kr');await seedUser('student@example.ac.kr');
  const owner=client();await login(owner);await owner('/posts/new');
  await owner('/posts',{title:'<script>alert(1)</script>',contest:'공모전',description:'<script>alert("내용")</script>',deadline:'2099-12-31',quota_0:'2'});
  assert.match((await owner('/posts/1')).html,/&lt;script&gt;/);
  db.prepare("UPDATE posts SET deadline='2000-01-01'").run();
  const c=client();await c('/login');await c('/login',{email:'student@example.ac.kr',password:'test-password-123'});await c('/posts/1');
  assert.equal((await c('/posts/1/apply',{motivation:'마감된 공고에는 지원할 수 없습니다.',skills:'JavaScript'})).status,409);
});
