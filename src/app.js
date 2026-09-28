import express from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import nodemailer from 'nodemailer';
import { randomBytes, createHash, scrypt as scryptCallback, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';
import { fileURLToPath } from 'node:url';
import { openDb, quotasFor, decideApplication } from './db.js';

const scrypt = promisify(scryptCallback);
const token = () => randomBytes(32).toString('hex');
const digest = value => createHash('sha256').update(value).digest('hex');
const fail = (message, status=400) => { throw Object.assign(new Error(message), {status}); };
const text = (value, label, max=2000, min=1) => {
  if (typeof value !== 'string' || value.trim().length < min || value.trim().length > max) fail(`${label}: ${min}~${max}자로 입력해 주세요.`);
  return value.trim();
};
export const today = () => new Intl.DateTimeFormat('sv-SE',{timeZone:'Asia/Seoul'}).format(new Date());
export async function hashPassword(password) {
  const salt = randomBytes(16).toString('hex');
  return `${salt}:${(await scrypt(password,salt,64)).toString('hex')}`;
}
async function validPassword(password, saved) {
  const [salt, hash] = saved.split(':');
  return timingSafeEqual(Buffer.from(hash,'hex'), await scrypt(password,salt,64));
}

export function createApp(options={}) {
  const production = process.env.NODE_ENV === 'production';
  const config = {
    school: process.env.SCHOOL_NAME || '우리 학교',
    domain: (process.env.SCHOOL_EMAIL_DOMAIN || 'example.ac.kr').trim().toLowerCase(),
    departments: (process.env.DEPARTMENTS || '컴퓨터공학과,소프트웨어학과,경영학과,디자인학과,전자공학과').split(',').map(s=>s.trim()).filter(Boolean),
    baseUrl: process.env.BASE_URL || 'http://localhost:3000',
    mailMode: process.env.MAIL_MODE || 'console', ...options.config
  };
  if (production && (config.mailMode !== 'smtp' || config.domain === 'example.ac.kr' || !config.baseUrl.startsWith('https://') || !process.env.SMTP_HOST || !process.env.MAIL_FROM)) {
    throw new Error('운영 환경에서는 실제 학교 도메인, HTTPS BASE_URL, SMTP_HOST, MAIL_FROM 및 MAIL_MODE=smtp 설정이 필요합니다.');
  }
  const db = options.db || openDb(process.env.DB_PATH || fileURLToPath(new URL('../data/campus.sqlite', import.meta.url)));
  const app = express();
  app.locals.db = db;
  app.disable('x-powered-by');
  app.set('view engine','ejs');
  app.set('views',fileURLToPath(new URL('../views',import.meta.url)));
  app.use(helmet());
  app.use(express.static(fileURLToPath(new URL('../public',import.meta.url))));
  app.use(express.urlencoded({extended:false, limit:'32kb'}));
  app.use(rateLimit({windowMs:60_000,limit:180,standardHeaders:'draft-8',legacyHeaders:false}));
  const authLimit = rateLimit({windowMs:15*60_000,limit:25,standardHeaders:'draft-8',legacyHeaders:false,message:'시도가 너무 많습니다. 15분 후 다시 시도해 주세요.'});
  const setSession = (req,res,userId=null) => {
    if (req.sessionHash) db.prepare('DELETE FROM sessions WHERE hash=?').run(req.sessionHash);
    const raw=token(), csrf=token(), expires=Date.now()+86400_000;
    req.sessionHash=digest(raw);
    db.prepare('INSERT INTO sessions(hash,user_id,csrf,expires) VALUES(?,?,?,?)').run(req.sessionHash,userId,csrf,expires);
    res.cookie('campus_sid',raw,{httpOnly:true,sameSite:'lax',secure:production,maxAge:86400_000,path:'/'});
    return {user_id:userId,csrf,expires};
  };
  app.use((req,res,next)=>{
    db.prepare('DELETE FROM sessions WHERE expires<?').run(Date.now());
    const raw=(req.headers.cookie||'').split(';').map(s=>s.trim()).find(s=>s.startsWith('campus_sid='))?.slice(11);
    req.sessionHash=raw ? digest(raw) : null;
    req.session=req.sessionHash ? db.prepare('SELECT * FROM sessions WHERE hash=? AND expires>?').get(req.sessionHash,Date.now()) : null;
    if (!req.session) req.session=setSession(req,res);
    req.user=req.session.user_id ? db.prepare('SELECT id,email,name,department,verified FROM users WHERE id=?').get(req.session.user_id) : null;
    Object.assign(res.locals,{user:req.user,csrf:req.session.csrf,config,title:'캠퍼스 팀업',today:today(),labels:{pending:'검토 중',approved:'승인',rejected:'거절'}});
    res.set('Cache-Control','no-store');
    if(req.method==='POST' && req.body._csrf!==req.session.csrf) return next(Object.assign(new Error('요청이 만료되었습니다. 화면을 새로고침한 후 다시 시도해 주세요.'),{status:403}));
    next();
  });
  const auth=(req,res,next)=>req.user?.verified ? next() : res.redirect('/login');
  const render=(res,view,data={})=>res.render('layout',{view,...data});
  const loadPost=id=>{
    const p=db.prepare('SELECT p.*,u.name AS owner_name FROM posts p JOIN users u ON u.id=p.owner_id WHERE p.id=?').get(id);
    if(!p) fail('공고를 찾을 수 없습니다.',404);
    return {...p,quotas:quotasFor(db,p.id)};
  };
  app.get('/login',(req,res)=>render(res,'auth',{mode:'login'}));
  app.get('/register',(req,res)=>render(res,'auth',{mode:'register'}));
  app.post('/register',authLimit,async(req,res)=>{
    const email=text(req.body.email,'학교 이메일',254).toLowerCase();
    if(!/^[^\s@]+@[^\s@]+$/.test(email) || email.split('@')[1]!==config.domain) fail(`@${config.domain} 학교 이메일로 가입해 주세요.`);
    const name=text(req.body.name,'이름',40), department=text(req.body.department,'학과',80);
    if(!config.departments.includes(department)) fail('등록된 학과를 선택해 주세요.');
    const password=text(req.body.password,'비밀번호',128,10);
    const existing=db.prepare('SELECT id,verified FROM users WHERE email=?').get(email);
    if(existing?.verified) fail('이미 가입된 이메일입니다. 로그인해 주세요.',409);
    const verification=token(), passwordHash=await hashPassword(password);
    // 미인증 계정 재가입은 메일 발송 실패 후 재시도도 가능하게 한다.
    db.prepare(`INSERT INTO users(email,name,department,password,verification_hash,verification_expires) VALUES(?,?,?,?,?,?)
      ON CONFLICT(email) DO UPDATE SET name=excluded.name,department=excluded.department,password=excluded.password,
      verification_hash=excluded.verification_hash,verification_expires=excluded.verification_expires WHERE users.verified=0`)
      .run(email,name,department,passwordHash,digest(verification),Date.now()+30*60_000);
    const url=`${config.baseUrl}/verify?token=${verification}`;
    if(options.sendVerification) await options.sendVerification(email,url);
    else if(config.mailMode==='console' && !production) console.log(`[로컬 시연용 이메일 인증] ${email}\n${url}`);
    else {
      const transport=nodemailer.createTransport({host:process.env.SMTP_HOST,port:Number(process.env.SMTP_PORT||587),secure:process.env.SMTP_PORT==='465',auth:process.env.SMTP_USER ? {user:process.env.SMTP_USER,pass:process.env.SMTP_PASS}:undefined});
      await transport.sendMail({from:process.env.MAIL_FROM,to:email,subject:`${config.school} 캠퍼스 팀업 이메일 인증`,text:`30분 안에 다음 링크를 열고 인증을 완료해 주세요.\n${url}`});
    }
    render(res,'message',{heading:'학교 이메일을 확인해 주세요',message:config.mailMode==='console'?'로컬 시연 모드입니다. 서버 터미널에 출력된 인증 링크를 열어 주세요. 실제 메일은 발송되지 않습니다.':'인증 링크를 보냈습니다. 30분 안에 인증 후 로그인해 주세요.'});
  });
  app.get('/verify',(req,res)=>{
    const verification=typeof req.query.token==='string'?req.query.token:'';
    const u=db.prepare('SELECT id FROM users WHERE verification_hash=? AND verification_expires>? AND verified=0').get(digest(verification),Date.now());
    if(!u) fail('인증 링크가 만료되었거나 이미 사용되었습니다. 미인증 계정은 다시 가입해 인증 링크를 받을 수 있습니다.');
    render(res,'verify',{verification});
  });
  app.post('/verify',(req,res)=>{
    const value=text(req.body.token,'인증 토큰',64,64);
    const result=db.prepare('UPDATE users SET verified=1,verification_hash=NULL,verification_expires=NULL WHERE verification_hash=? AND verification_expires>? AND verified=0').run(digest(value),Date.now());
    if(!result.changes) fail('인증 링크가 만료되었거나 이미 사용되었습니다.');
    render(res,'message',{heading:'학교 인증이 완료됐어요',message:'이제 로그인해서 함께할 팀원을 찾아보세요.'});
  });
  app.post('/login',authLimit,async(req,res)=>{
    const email=text(req.body.email,'이메일',254).toLowerCase(), password=text(req.body.password,'비밀번호',128);
    const u=db.prepare('SELECT * FROM users WHERE email=?').get(email);
    if(!u || !await validPassword(password,u.password)) fail('이메일 또는 비밀번호를 확인해 주세요.',401);
    if(!u.verified) fail('학교 이메일 인증을 먼저 완료해 주세요.',403);
    setSession(req,res,u.id); res.redirect('/');
  });
  app.post('/logout',(req,res)=>{setSession(req,res);res.redirect('/login');});
  app.get('/',auth,(req,res)=>{
    const posts=db.prepare('SELECT p.*,u.name AS owner_name FROM posts p JOIN users u ON u.id=p.owner_id ORDER BY p.id DESC').all().map(p=>({...p,quotas:quotasFor(db,p.id)}));
    render(res,'home',{posts});
  });
  app.get('/posts/new',auth,(req,res)=>render(res,'new'));
  app.post('/posts',auth,(req,res)=>{
    const title=text(req.body.title,'공고 제목',100),contest=text(req.body.contest,'공모전명',100),description=text(req.body.description,'모집 내용',5000,10);
    const deadline=text(req.body.deadline,'마감일',10,10);
    if(!/^\d{4}-\d{2}-\d{2}$/.test(deadline) || Number.isNaN(Date.parse(deadline)) || new Date(deadline).toISOString().slice(0,10)!==deadline || deadline<today()) fail('마감일은 오늘 이후의 유효한 날짜여야 합니다.');
    const quotas=config.departments.map((department,i)=>({department,capacity:Number(req.body[`quota_${i}`]||0)}));
    if(quotas.some(q=>!Number.isInteger(q.capacity)||q.capacity<0||q.capacity>20)||!quotas.some(q=>q.capacity>0)) fail('모집 인원은 학과별 0~20명이며, 한 학과 이상 모집해야 합니다.');
    db.exec('BEGIN IMMEDIATE');
    let id;
    try {
      id=Number(db.prepare('INSERT INTO posts(owner_id,title,contest,description,deadline) VALUES(?,?,?,?,?)').run(req.user.id,title,contest,description,deadline).lastInsertRowid);
      for(const q of quotas.filter(q=>q.capacity>0)) db.prepare('INSERT INTO quotas VALUES(?,?,?)').run(id,q.department,q.capacity);
      db.exec('COMMIT');
    }catch(e){db.exec('ROLLBACK');throw e;}
    res.redirect(`/posts/${id}`);
  });
  app.get('/posts/:id',auth,(req,res)=>{
    const post=loadPost(req.params.id);
    const own=post.owner_id===req.user.id;
    const applications=own ? db.prepare('SELECT a.*,u.name,u.email FROM applications a JOIN users u ON u.id=a.user_id WHERE a.post_id=? ORDER BY a.id DESC').all(post.id):[];
    const application=db.prepare('SELECT * FROM applications WHERE post_id=? AND user_id=?').get(post.id,req.user.id);
    render(res,'detail',{post,own,applications,application});
  });
  app.post('/posts/:id/apply',auth,(req,res)=>{
    const post=loadPost(req.params.id);
    if(post.owner_id===req.user.id) fail('자신의 공고에는 지원할 수 없습니다.');
    if(post.deadline<today()) fail('모집이 마감되었습니다.',409);
    const quota=post.quotas.find(q=>q.department===req.user.department);
    if(!quota || quota.filled>=quota.capacity) fail('소속 학과의 모집 인원이 없거나 정원이 찼습니다.',409);
    const motivation=text(req.body.motivation,'지원 동기',2000,10), skills=text(req.body.skills,'보유 기술 및 경험',2000,2);
    if(db.prepare('SELECT id FROM applications WHERE post_id=? AND user_id=?').get(post.id,req.user.id)) fail('이미 지원한 공고입니다.',409);
    db.prepare('INSERT INTO applications(post_id,user_id,department,motivation,skills) VALUES(?,?,?,?,?)').run(post.id,req.user.id,req.user.department,motivation,skills);
    res.redirect(`/posts/${post.id}`);
  });
  app.post('/applications/:id/decision',auth,(req,res)=>{
    const postId=decideApplication(db,req.params.id,req.user.id,req.body.status);
    res.redirect(`/posts/${postId}`);
  });
  app.get('/my',auth,(req,res)=>{
    const posts=db.prepare('SELECT * FROM posts WHERE owner_id=? ORDER BY id DESC').all(req.user.id);
    const applications=db.prepare('SELECT a.*,p.title FROM applications a JOIN posts p ON p.id=a.post_id WHERE a.user_id=? ORDER BY a.id DESC').all(req.user.id);
    render(res,'my',{posts,applications});
  });
  app.use((req,res)=>res.status(404).render('layout',{view:'message',heading:'페이지를 찾을 수 없어요',message:'주소를 확인하거나 모집 공고 목록으로 돌아가 주세요.'}));
  app.use((err,req,res,next)=>{
    const status=err.status||500;
    if(status>=500) console.error(err.message);
    res.status(status).render('layout',{view:'message',heading:status>=500?'잠시 후 다시 시도해 주세요':'요청을 처리하지 못했어요',message:status>=500?'서버 처리 중 오류가 발생했습니다. 메일 발송 실패 시 설정을 확인하고 다시 가입해 주세요.':err.message});
  });
  return app;
}
