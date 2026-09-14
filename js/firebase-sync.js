/* ====================================================================
   طبقة المزامنة السحابية (Firebase) — إضافية وليست بديلة
   ====================================================================
   مبدأ التصميم: التطبيق يعمل بكامل وظائفه بلا إنترنت كما هو الآن
   (يقرأ من localStorage فوراً عبر loadSettings()). هذه الطبقة، إن
   توفرت بياناتها (FIREBASE_CONFIG معرّف وصالح)، تُضيف فقط:
     1) قراءة معاملات الحساب (calc/iqama) من Firebase وتطبيقها إن تغيّرت
     2) قراءة الإعلانات من Firebase ودمجها في نفس دورة feedItems() الحالية
     3) نبضة قلب (heartbeat) دورية لمعرفة أن الشاشة "متصلة"
     4) الاستماع لأمر "تحديث الشاشة" من لوحة التحكم
   أي خطأ هنا (لا إنترنت، لا مشروع Firebase، خطأ إعداد) يجب ألا يُسقط
   التطبيق أو يُغيّر أي شيء ظاهر للمصلين — يُسجَّل في Console فقط.
   ==================================================================== */
(function(){
  'use strict';
  const cfg = window.FIREBASE_CONFIG;
  const screenId = window.SCREEN_ID || 'UNKNOWN-SCREEN';
  const appVersion = window.APP_VERSION || '0.0.0';

  const cloudState = { connected:false, lastSync:0, lastError:'' };
  window.__cloudState = cloudState; // تعرضه الواجهة إن أردت مؤشر "متصل/غير متصل"

  if(!cfg || !cfg.apiKey || cfg.apiKey.indexOf('ضع-') === 0){
    console.info('[cloud] FIREBASE_CONFIG غير مُعرَّف — التطبيق يعمل محلياً بلا مزامنة سحابية (هذا طبيعي وآمن).');
    return;
  }
  if(typeof firebase === 'undefined'){
    console.warn('[cloud] مكتبة Firebase SDK لم تُحمَّل (لا إنترنت على الأرجح) — الاستمرار محلياً.');
    return;
  }

  let db=null, auth=null;
  try{
    firebase.initializeApp(cfg);
    db = firebase.database();
    auth = firebase.auth();
  }catch(e){
    console.error('[cloud] فشل تهيئة Firebase:', e);
    return;
  }

  function safeApply(fn){
    try{ fn(); }catch(e){ console.error('[cloud] خطأ أثناء تطبيق بيانات سحابية:', e); }
  }

  // ---------- 1) تسجيل دخول مجهول (القراءة فقط تكفي الشاشة) ----------
  auth.signInAnonymously().catch(e=>{
    cloudState.lastError = 'auth: '+(e&&e.message||e);
    console.warn('[cloud] تعذّر تسجيل الدخول المجهول:', e);
  });

  auth.onAuthStateChanged(user=>{
    if(!user) return;
    cloudState.connected = true;
    attachListeners();
    startHeartbeat();
  });

  // ---------- 2) الاستماع لمعاملات الحساب + الإقامة ----------
  function attachListeners(){
    const base = db.ref('mosque');

    base.child('calc').on('value', snap=>{
      const v = snap.val(); if(!v) return;
      safeApply(()=>{
        // دمج جزئي: لا نستبدل كل شيء، فقط الحقول الموجودة فعلياً في Firebase
        S.calc = Object.assign({}, S.calc, v, { adj: Object.assign({}, S.calc.adj, v.adj||{}) });
        saveSettings();
        resetCache(); render(nowWall()); layout();
      });
      cloudState.lastSync = Date.now();
    }, err=>onRtdbError('calc', err));

    base.child('iqama').on('value', snap=>{
      const v = snap.val(); if(!v) return;
      safeApply(()=>{
        S.iqama = Object.assign({}, S.iqama, v);
        saveSettings();
        resetCache(); render(nowWall()); layout();
      });
      cloudState.lastSync = Date.now();
    }, err=>onRtdbError('iqama', err));

    base.child('settings').on('value', snap=>{
      const v = snap.val(); if(!v) return;
      safeApply(()=>{
        if(v.mosqueNameAr) S.mosque.nameAr = v.mosqueNameAr;
        if(v.mosqueNameEn) S.mosque.nameEn = v.mosqueNameEn;
        saveSettings();
        applyI18n && applyI18n();
      });
    }, err=>onRtdbError('settings', err));

    // ---------- 3) الإعلانات: تُدمَج مع نظام الإعلانات المحلي/GitHub الحالي ----------
    base.child('announcements').on('value', snap=>{
      const obj = snap.val() || {};
      const now = nowWall();
      const items = Object.keys(obj).map(k=>({ id:k, ...obj[k] }))
        .filter(a=>a.active !== false)
        .filter(a=>cloudAdInWindow(a, now))
        .sort((a,b)=>(a.priority||99)-(b.priority||99))
        .map(a=>({ text:a.title ? (a.title+' — '+(a.body||'')) : (a.body||''), from:a.startDate||'', to:a.endDate||'', on:true, _cloud:true }));
      safeApply(()=>{
        window.CLOUD_ADS = items; // يُقرأ من feedItems() المُعدَّلة أدناه
        if(typeof startDua === 'function') startDua();
      });
    }, err=>onRtdbError('announcements', err));

    // ---------- 4) أمر تحديث الشاشة عن بُعد (ينفَّذ مرة واحدة) ----------
    db.ref('commands/'+screenId+'/refresh').on('value', snap=>{
      if(snap.val() === true){
        db.ref('commands/'+screenId+'/refresh').set(false).finally(()=>location.reload());
      }
    }, err=>onRtdbError('commands', err));
  }

  function cloudAdInWindow(a, now){
    const d = new Date(now), pad=n=>String(n).padStart(2,'0');
    const today = d.getFullYear()+'-'+pad(d.getMonth()+1)+'-'+pad(d.getDate());
    if(a.startDate && today < a.startDate) return false;
    if(a.endDate && today > a.endDate) return false;
    if(a.startTime || a.endTime){
      const hm = pad(d.getHours())+':'+pad(d.getMinutes());
      if(a.startTime && hm < a.startTime) return false;
      if(a.endTime && hm > a.endTime) return false;
    }
    return true;
  }

  function onRtdbError(path, err){
    cloudState.connected = false;
    cloudState.lastError = path+': '+(err&&err.message||err);
    console.warn('[cloud] فشلت القراءة من', path, err);
    // لا نفعل أي شيء آخر — التطبيق يستمر بآخر بيانات محلية صحيحة (كما هي مصممة أصلاً)
  }

  // ---------- 5) نبضة القلب (heartbeat) ----------
  let hbTimer = null;
  function startHeartbeat(){
    const send = ()=>{
      db.ref('display/screens/'+screenId).update({
        online: true,
        lastHeartbeat: firebase.database.ServerValue.TIMESTAMP,
        appVersion: appVersion,
        dataVersion: cloudState.lastSync || Date.now(),
        userAgent: navigator.userAgent.slice(0,180)
      }).catch(e=>{ cloudState.lastError='heartbeat: '+(e&&e.message||e); });
    };
    // عند قطع الاتصال يُعلِم Firebase تلقائياً بأن الشاشة offline
    db.ref('display/screens/'+screenId).onDisconnect().update({
      online:false, lastHeartbeat: firebase.database.ServerValue.TIMESTAMP
    });
    send();
    clearInterval(hbTimer);
    hbTimer = setInterval(send, 45000);
    // انتعاش فوري: لا ننتظر حتى 45 ثانية القادمة إن عاد الاتصال بعد انقطاع
    // (Firebase SDK نفسه يُعيد الاتصال بالمستمعين تلقائياً؛ هذا فقط يُسرّع تحديث "متصلة" في لوحة التحكم)
    db.ref('.info/connected').on('value', snap=>{
      const on = snap.val() === true;
      cloudState.connected = on;
      if(on) send();
    });
  }

  // انتعاش عند عودة الشبكة على مستوى المتصفح نفسه (مفيد إن كان Firebase لم يكتشف بعد)
  window.addEventListener('online', ()=>{ if(db) db.ref('.info/connected').once('value'); });


  console.info('[cloud] طبقة المزامنة السحابية جاهزة. المعرّف:', screenId);
})();
