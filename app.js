// =========================
// Firebase SDK (v10 modular)
// =========================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut, getIdTokenResult
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, enableIndexedDbPersistence,
  collection, doc, getDoc, getDocs, query, where, addDoc,
  setDoc, deleteDoc, serverTimestamp, orderBy, onSnapshot, limit, writeBatch, startAfter
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// =========================
// Firebase config（差し替え）
// =========================
const firebaseConfig = {
  apiKey: "AIzaSyCTDbkmGXMH1YDkLIgOH_yBWKCUYOMgoSg",
  authDomain: "udon-map.firebaseapp.com",
  projectId: "udon-map"
};

// =========================
// App bootstrap
// =========================
const appFB = initializeApp(firebaseConfig);
const auth = getAuth(appFB);
const db   = getFirestore(appFB);

// オフライン（任意）
enableIndexedDbPersistence(db).catch(()=>{});

const PREFS = ["福岡","佐賀","長崎","熊本","大分","宮崎","鹿児島"];

// submissions 並び替え：インデックスREADY前はfalse
let USE_INDEXED_ORDER_FOR_SUBMISSIONS = true;

let currentUser = null;
let isAdmin = false;

let state = {
  tab: "home",
  selectedPref: null,
  search: ""
};

const $ = sel => document.querySelector(sel);
const appRoot = $('#app');

// =========================
// Auth UI
// =========================
function renderAuthArea(){
  const el = $('#authArea');
  if(!el) return;
  el.innerHTML = "";
  const wrap = document.createElement('div');
  wrap.className = "auth";
  if(currentUser){
    const chip = document.createElement('span');
    chip.className = "chip";
    chip.textContent = `こんにちは、${currentUser.displayName ?? "ユーザー"} さん`;
    const btn = document.createElement('button');
    btn.className = "auth-btn";
    btn.textContent = "ログアウト";
    btn.onclick = () => signOut(auth).catch(e=>alert(e.message));
    wrap.append(chip, btn);
  }else{
    const btn = document.createElement('button');
    btn.className = "auth-btn";
    btn.textContent = "Googleでログイン";
    btn.onclick = () => {
      const provider = new GoogleAuthProvider();
      signInWithPopup(auth, provider).catch(e=>alert(e.message));
    };
    wrap.append(btn);
  }
  el.appendChild(wrap);
}
function ensureAdminTab(){
  const tabs = $('#tabs');
  if(!tabs) return;
  const exists = tabs.querySelector('[data-tab="admin"]');
  if(isAdmin && !exists){
    const btn = document.createElement('button');
    btn.dataset.tab = "admin";
    btn.className = "tab";
    btn.textContent = "管理";
    tabs.appendChild(btn);
  }else if(!isAdmin && exists){
    exists.remove();
    if(state.tab === "admin"){ state.tab = "home"; }
  }
}
onAuthStateChanged(auth, async (user)=>{
  currentUser = user;
  isAdmin = false;
  if (user) {
    try {
      const token = await getIdTokenResult(user);
      isAdmin = !!token.claims?.admin;
    } catch(_e){}
  }
  renderAuthArea();
  ensureAdminTab();
  startWatchFavorites();
  render();
});

// =========================
// Helpers
// =========================
function mapsLinkFromAddress(address){
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address||"")}`;
}
function h2(text){
  const t = document.createElement('h2');
  t.className = 'section-title';
  t.textContent = text;
  return t;
}
function loader(text="読み込み中…"){
  const d = document.createElement('div');
  d.className = 'loader';
  d.textContent = text;
  return d;
}
function normalize(str){ return (str||"").trim(); }
function normalizeKey(str){
  return (str||"")
    .replace(/\s+/g,"")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, s=>String.fromCharCode(s.charCodeAt(0)-0xFEE0))
    .toLowerCase();
}

// =========================
// shops（公開データ）
// =========================
async function fetchShopsByPref(pref, keyword=""){
  const qCol = collection(db, "shops");
  const qy = query(qCol, where("pref","==",pref), where("status","==","published"));
  const snap = await getDocs(qy);
  let rows = snap.docs.map(d=>({id:d.id, ...d.data()}));
  if(keyword){
    const ql = keyword.toLowerCase();
    rows = rows.filter(r=>{
      const s = (r.name + (r.address??"") + (r.note??"")).toLowerCase();
      return s.includes(ql);
    });
  }
  rows.sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  return rows;
}

// =========================
// Favorites（一括購読）
// =========================
let favUnsub = null;
let favSet = new Set(); // shopId の集合

function startWatchFavorites() {
  if (favUnsub) { favUnsub(); favUnsub=null; }
  if (!currentUser) { favSet = new Set(); return; }
  const col = collection(db, "users", currentUser.uid, "favorites");
  favUnsub = onSnapshot(col, snap => {
    favSet = new Set(snap.docs.map(d => d.id));
    if (state.tab === "home" || state.tab === "favorites") render();
  });
}

async function toggleFav(shop){
  if(!currentUser){ alert("お気に入りはログインが必要です"); return; }
  const favRef = doc(db, "users", currentUser.uid, "favorites", shop.id);
  const existed = favSet.has(shop.id);

  // 楽観更新
  if (existed) favSet.delete(shop.id); else favSet.add(shop.id);
  render();

  try {
    if (existed) await deleteDoc(favRef);
    else await setDoc(favRef, { shopRef: doc(db,"shops",shop.id), createdAt: serverTimestamp() });
  } catch(e){
    if (existed) favSet.add(shop.id); else favSet.delete(shop.id);
    render();
    alert("更新に失敗しました: " + e.message);
  }
}

async function fetchFavorites(){
  if(!currentUser) return [];
  const snap = await getDocs(collection(db, "users", currentUser.uid, "favorites"));
  const results = [];
  for (const d of snap.docs){
    const shopId = d.id;
    const sdoc = await getDoc(doc(db,"shops",shopId));
    if(sdoc.exists()){
      results.push({ id: shopId, ...sdoc.data() });
    }
  }
  results.sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  return results;
}

// =========================
// Submissions（新規登録）
// =========================
const SUBMIT_COOLDOWN_MS = 60 * 1000;
const PENDING_LIMIT_PER_USER = 10;

function getLastSubmitTs(){
  try{ return Number(localStorage.getItem("udon_submit_lastts")||"0"); }catch(_e){ return 0; }
}
function setLastSubmitTs(ts){ try{ localStorage.setItem("udon_submit_lastts", String(ts)); }catch(_e){} }

async function hasPendingQuota(){
  if(!currentUser) return true;
  const qy = query(
    collection(db,"submissions"),
    where("submittedByUid","==", currentUser.uid),
    where("status","==","pending"),
    limit(PENDING_LIMIT_PER_USER)
  );
  const snap = await getDocs(qy);
  return snap.size < PENDING_LIMIT_PER_USER;
}

async function checkDuplicate(pref, name, address){
  const rows = await fetchShopsByPref(pref, "");
  const keyName = normalizeKey(name);
  const keyAddr = normalizeKey(address);
  const dup = rows.find(r=>{
    return normalizeKey(r.name) === keyName || normalizeKey(r.address||"") === keyAddr;
  });
  return dup || null;
}

async function submitNewShop(model){
  const now = Date.now();

  const last = getLastSubmitTs();
  if (now - last < SUBMIT_COOLDOWN_MS){
    const sec = Math.ceil((SUBMIT_COOLDOWN_MS - (now-last))/1000);
    throw new Error(`送信間隔が短すぎます。${sec}秒後に再度お試しください。`);
  }

  if(!currentUser){
    throw new Error("申請はログインが必要です（審査状況の確認・編集のため）");
  }

  if(!(await hasPendingQuota())){
    throw new Error(`審査中の申請が上限（${PENDING_LIMIT_PER_USER}件）に達しています。結果が出るまでお待ちください。`);
  }

  const dup = await checkDuplicate(model.pref, model.name, model.address);
  if (dup){
    throw new Error(`既に掲載済みの可能性があります：「${dup.name}」（${dup.address||""}）`);
  }

  const payload = {
    pref: normalize(model.pref),
    name: normalize(model.name),
    address: normalize(model.address),
    note: normalize(model.note),
    nameKey: normalizeKey(model.name),
    addrKey: normalizeKey(model.address),
    status: "pending",
    submittedByUid: currentUser.uid,
    submittedByEmail: currentUser.email || null,
    userAgent: navigator.userAgent || null,
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp()
  };

  await addDoc(collection(db, "submissions"), payload);
  setLastSubmitTs(now);
}

async function fetchMySubmissions(){
  if(!currentUser) return [];
  try {
    let qy;
    if (USE_INDEXED_ORDER_FOR_SUBMISSIONS) {
      qy = query(
        collection(db,"submissions"),
        where("submittedByUid","==", currentUser.uid),
        orderBy("createdAt","desc")
      );
    } else {
      qy = query(
        collection(db,"submissions"),
        where("submittedByUid","==", currentUser.uid)
      );
    }
    const snap = await getDocs(qy);
    const rows = snap.docs.map(d=>({ id:d.id, ...d.data() }));
    if (!USE_INDEXED_ORDER_FOR_SUBMISSIONS) {
      rows.sort((a,b)=>{
        const ta = a.createdAt?.toMillis?.() ?? 0;
        const tb = b.createdAt?.toMillis?.() ?? 0;
        return tb - ta;
      });
    }
    return rows;
  } catch (e) {
    if (e.code === 'failed-precondition') {
      throw new Error('インデックス未作成または向き不一致です（submittedByUid Asc / createdAt Desc で作成してください）');
    }
    if (e.code === 'permission-denied') {
      throw new Error('権限エラー：ルールまたはログイン状態を確認してください');
    }
    throw e;
  }
}

async function updateSubmission(id, patch){
  const ref = doc(db,"submissions", id);
  const cur = await getDoc(ref);
  if(!cur.exists()) throw new Error("申請が見つかりません");
  const data = cur.data();
  if(!currentUser || data.submittedByUid !== currentUser.uid) throw new Error("権限がありません");
  if(data.status !== "pending") throw new Error("審査中以外は編集できません");
  const next = {
    ...patch,
    nameKey: normalizeKey(patch.name ?? data.name),
    addrKey: normalizeKey(patch.address ?? data.address),
    updatedAt: serverTimestamp()
  };
  await setDoc(ref, next, { merge: true });
}

async function deleteSubmission(id){
  const ref = doc(db,"submissions", id);
  const cur = await getDoc(ref);
  if(!cur.exists()) return;
  const data = cur.data();
  if(!currentUser || data.submittedByUid !== currentUser.uid) throw new Error("権限がありません");
  if(data.status !== "pending") throw new Error("審査中以外は削除できません");
  await deleteDoc(ref);
}

// =========================
// Admin: 承認/却下
// =========================
async function adminApproveSubmission(sub){
  if(!isAdmin){ alert("管理者のみ操作できます"); return; }
  // shops へコピー + submissions を approved に更新（バッチ）
  const batch = writeBatch(db);
  const shopRef = doc(collection(db, "shops"));
  const subRef  = doc(db, "submissions", sub.id);

  const shopDoc = {
    pref: sub.pref,
    name: sub.name,
    address: sub.address,
    note: sub.note || "",
    status: "published",
    createdAt: serverTimestamp(),
    updatedAt: serverTimestamp(),
    sourceSubmissionId: sub.id,
    approvedByUid: currentUser.uid
  };
  batch.set(shopRef, shopDoc);
  batch.set(subRef, { status: "approved", approvedAt: serverTimestamp(), approvedShopId: shopRef.id }, { merge: true });

  await batch.commit();
}

async function adminRejectSubmission(sub, reason="不適切・重複など"){
  if(!isAdmin){ alert("管理者のみ操作できます"); return; }
  const subRef = doc(db, "submissions", sub.id);
  await setDoc(subRef, { status: "rejected", rejectedAt: serverTimestamp(), rejectReason: reason }, { merge: true });
}

// =========================
/* Views */
// =========================
async function render(){
  document.querySelectorAll('.tab').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.tab === state.tab);
  });

  if(state.tab === "home")       await renderHome();
  if(state.tab === "favorites")  await renderFavorites();
  if(state.tab === "new")        await renderNew();
  if(state.tab === "admin")      await renderAdmin();
}

// Home
async function renderHome(){
  const container = document.createElement('div');
  container.className = 'container';

  container.appendChild(h2('都道府県を選ぶ'));
  const grid = document.createElement('div');
  grid.className = 'pref-grid';
  PREFS.forEach(p=>{
    const b = document.createElement('button');
    b.className = 'pref';
    b.textContent = p;
    b.onclick = ()=>{ state.selectedPref=p; state.search=""; render(); };
    grid.appendChild(b);
  });
  container.appendChild(grid);

  if(state.selectedPref){
    container.appendChild(document.createElement('hr'));
    const t = document.createElement('h3'); t.className = 'section-title';
    t.textContent = `${state.selectedPref}のうどん店`;
    container.appendChild(t);

    const tools = document.createElement('div'); tools.className='toolbar';
    const input = document.createElement('input');
    input.className='input'; input.placeholder='店名・住所で検索';
    input.value = state.search;
    input.oninput = (e)=>{ state.search = e.target.value; render(); };
    const clear = document.createElement('button');
    clear.className='btn btn-outline'; clear.textContent='県を変更';
    clear.onclick = ()=>{ state.selectedPref=null; state.search=""; render(); };
    tools.append(input, clear);
    container.appendChild(tools);

    const listWrap = document.createElement('div');
    listWrap.appendChild(loader());
    container.appendChild(listWrap);

    appRoot.replaceChildren(container);

    const rows = await fetchShopsByPref(state.selectedPref, state.search);
    const list = document.createElement('div'); list.className = 'list';

    if(rows.length === 0){
      const empty = document.createElement('div'); empty.className='empty';
      empty.textContent = '該当する店舗がありません。検索条件を見直してください。';
      listWrap.replaceChildren(empty);
      return;
    }

    for(const r of rows){
      const card = document.createElement('div'); card.className = 'card';
      const h3 = document.createElement('h3'); h3.textContent = r.name;
      const meta = document.createElement('div'); meta.className='meta';
      meta.innerHTML = `
        <span class="badge">${r.pref}</span>
        <div>${r.address??""}</div>
        ${r.note?`<div>${r.note}</div>`:""}
      `;
      const actions = document.createElement('div'); actions.className='actions';

      const detailBtn = document.createElement('button');
      detailBtn.className='btn btn-primary'; detailBtn.textContent='店舗詳細';
      detailBtn.onclick = ()=>renderDetail(r);

      const favBtn = document.createElement('button');
      favBtn.className='btn btn-outline';
      favBtn.textContent = favSet.has(r.id) ? '★ お気に入り済' : '☆ お気に入り';
      favBtn.onclick = ()=>toggleFav(r);

      actions.append(detailBtn, favBtn);
      card.append(h3, meta, actions);
      list.appendChild(card);
    }
    listWrap.replaceChildren(list);
    return;
  }

  appRoot.replaceChildren(container);
}

// 店舗詳細
function renderDetail(shop){
  const container = document.createElement('div');
  container.className='container';

  const box = document.createElement('div'); box.className='detail';
  const h2El = document.createElement('h2'); h2El.textContent = shop.name;

  const meta = document.createElement('div'); meta.className='meta';
  meta.innerHTML = `
    <div><span class="badge">${shop.pref}</span></div>
    <div style="margin:6px 0">${shop.address??""}</div>
    ${shop.note?`<div>${shop.note}</div>`:""}
  `;

  const actions = document.createElement('div'); actions.className='actions';
  const map = document.createElement('a'); map.className='btn btn-primary';
  map.href = mapsLinkFromAddress(shop.address??""); map.target="_blank"; map.rel="noopener";
  map.textContent = 'Googleマップで開く';

  const fav = document.createElement('button'); fav.className='btn btn-outline';
  fav.textContent = favSet.has(shop.id) ? '★ お気に入り済' : '☆ お気に入り';
  fav.onclick = ()=>{ toggleFav(shop); };

  const back = document.createElement('button'); back.className='btn btn-ghost'; back.textContent='戻る';
  back.onclick = ()=>render();

  actions.append(map,fav,back);
  box.append(h2El,meta,actions);
  container.appendChild(box);
  appRoot.replaceChildren(container);
}

// マイページ
async function renderFavorites(){
  const container = document.createElement('div'); container.className='container';
  container.appendChild(h2('お気に入り店舗'));

  if(!currentUser){
    const box = document.createElement('div'); box.className='empty';
    box.textContent = 'お気に入りを表示するにはログインしてください。';
    container.appendChild(box);
    appRoot.replaceChildren(container);
    return;
  }

  const listWrap = document.createElement('div'); listWrap.appendChild(loader());
  container.appendChild(listWrap);
  appRoot.replaceChildren(container);

  const favs = await fetchFavorites();
  if(favs.length===0){
    const empty = document.createElement('div'); empty.className='empty';
    empty.textContent = 'まだお気に入りがありません。ホームから☆で追加できます。';
    listWrap.replaceChildren(empty);
    return;
  }

  const list = document.createElement('div'); list.className='list';
  favs.forEach(r=>{
    const card = document.createElement('div'); card.className='card';
    const h3 = document.createElement('h3'); h3.textContent=r.name;
    const meta = document.createElement('div'); meta.className='meta';
    meta.innerHTML = `<span class="badge">${r.pref}</span><div>${r.address??""}</div>`;
    const actions = document.createElement('div'); actions.className='actions';
    const map = document.createElement('a'); map.className='btn btn-primary';
    map.href = mapsLinkFromAddress(r.address??""); map.target="_blank"; map.rel="noopener";
    map.textContent='地図';
    const del = document.createElement('button'); del.className='btn btn-outline';
    del.textContent='お気に入り解除';
    del.onclick = ()=>toggleFav(r);
    actions.append(map,del);
    card.append(h3,meta,actions);
    list.appendChild(card);
  });
  listWrap.replaceChildren(list);
}

// 新規登録（審査制・ユーザー）
function renderNew(){
  const container = document.createElement('div');
  container.className='container';

  const title = h2('新規登録（審査制）');
  const form = document.createElement('div'); form.className='form';

  const model = { pref:PREFS[0], name:"", address:"", note:"" };

  const rows = [
    {key:'pref', label:'都道府県', el: ()=>selectPref()},
    {key:'name', label:'店名', el: ()=>inputText('例）うどん処 ○○（必須）', 64)},
    {key:'address', label:'住所', el: ()=>inputText('例）福岡市○○区…（必須）', 128)},
    {key:'note', label:'メモ', el: ()=>inputText('任意：名物や補足など', 128)}
  ];

  rows.forEach(r=>{
    const row = document.createElement('div'); row.className='form-row';
    const lab = document.createElement('label'); lab.textContent=r.label;
    const el = r.el();
    el.oninput = (e)=>{ model[r.key] = e.target.value; };
    if(r.key==='pref'){ el.onchange = (e)=>{ model.pref = e.target.value; }; }
    row.append(lab,el);
    form.appendChild(row);
  });

  const actions = document.createElement('div'); actions.className='actions';
  const send = document.createElement('button'); send.className='btn btn-primary'; send.textContent='申請する';
  send.onclick = async ()=>{
    try{
      if(!normalize(model.name) || !normalize(model.address)){
        alert('店名と住所は必須です'); return;
      }
      await submitNewShop(model);
      alert('送信しました。審査後に掲載されます。');
      renderMySubmissionsView(container);
    }catch(e){
      alert(e.message);
    }
  };
  const cancel = document.createElement('button'); cancel.className='btn btn-outline'; cancel.textContent='キャンセル';
  cancel.onclick = ()=>{ state.tab='home'; render(); };
  actions.append(cancel,send);

  form.appendChild(actions);
  container.append(title,form);

  if(!currentUser){
    const note = document.createElement('div');
    note.className = 'empty';
    note.textContent = '※ ログインすると申請の編集・削除ができ、審査状況も確認できます。';
    container.appendChild(note);
  }else{
    renderMySubmissionsView(container);
  }

  appRoot.replaceChildren(container);

  function inputText(ph, max=128){
    const i = document.createElement('input'); i.className='input'; i.placeholder=ph; i.maxLength = max; return i;
  }
  function selectPref(){
    const s = document.createElement('select'); s.className='select';
    PREFS.forEach(p=>{ const o=document.createElement('option'); o.value=p; o.textContent=p; s.appendChild(o); });
    return s;
  }
}

// 自分の申請一覧UI（編集・削除可）
async function renderMySubmissionsView(container){
  const wrap = document.createElement('div');
  wrap.style.marginTop = '16px';

  const title = document.createElement('h3'); title.className='section-title'; title.textContent = 'あなたの申請一覧';
  wrap.appendChild(title);

  if(!currentUser){
    const empty = document.createElement('div'); empty.className='empty';
    empty.textContent = 'ログインすると申請履歴を確認できます。';
    wrap.appendChild(empty);
    container.appendChild(wrap);
    return;
  }

  const listWrap = document.createElement('div'); listWrap.appendChild(loader());
  wrap.appendChild(listWrap);
  container.appendChild(wrap);

  let rows = [];
  try {
    rows = await fetchMySubmissions();
  } catch (e) {
    const box = document.createElement('div');
    box.className = 'empty';
    box.textContent = '申請一覧の取得でエラー：' + (e.message || e);
    listWrap.replaceChildren(box);
    console.error(e);
    return;
  }

  if(rows.length===0){
    const empty = document.createElement('div'); empty.className='empty';
    empty.textContent = '申請はまだありません。';
    listWrap.replaceChildren(empty);
    return;
  }

  const list = document.createElement('div'); list.className='list';
  rows.forEach(r=>{
    const card = document.createElement('div'); card.className='card';
    const h3 = document.createElement('h3'); h3.textContent = r.name;
    const meta = document.createElement('div'); meta.className='meta';
    meta.innerHTML = `
      <span class="badge">${r.pref}</span>
      <div>${r.address??""}</div>
      ${r.note?`<div>${r.note}</div>`:""}
      <div>ステータス：<strong>${r.status}</strong></div>
    `;

    const actions = document.createElement('div'); actions.className='actions';

    const map = document.createElement('a'); map.className='btn btn-primary';
    map.href = mapsLinkFromAddress(r.address??""); map.target="_blank"; map.rel="noopener";
    map.textContent='地図';

    const canEdit = r.status === "pending" && currentUser && r.submittedByUid === currentUser.uid;

    const edit = document.createElement('button'); edit.className='btn btn-outline'; edit.textContent='編集';
    edit.disabled = !canEdit;
    edit.onclick = async ()=>{
      const name = prompt('店名を修正', r.name); if(name===null) return;
      const address = prompt('住所を修正', r.address); if(address===null) return;
      const note = prompt('メモを修正（空でも可）', r.note ?? ""); if(note===null) return;
      try{
        await updateSubmission(r.id, { name, address, note });
        alert('更新しました'); render();
      }catch(e){ alert(e.message); }
    };

    const del = document.createElement('button'); del.className='btn'; del.textContent='削除';
    del.disabled = !canEdit;
    del.onclick = async ()=>{
      if(!confirm('この申請を削除しますか？')) return;
      try{ await deleteSubmission(r.id); alert('削除しました'); render(); }
      catch(e){ alert(e.message); }
    };

    actions.append(map, edit, del);
    card.append(h3, meta, actions);
    list.appendChild(card);
  });
  listWrap.replaceChildren(list);
}

// 管理タブ（pending一覧→承認/却下）
async function renderAdmin(){
  if(!isAdmin){
    const c = document.createElement('div'); c.className='container';
    const box = document.createElement('div'); box.className='empty';
    box.textContent = '管理者のみアクセスできます。';
    c.appendChild(box);
    appRoot.replaceChildren(c);
    return;
  }

  const container = document.createElement('div'); container.className='container';
  container.appendChild(h2('管理：申請の承認・却下'));

  // ツールバー
  const tools = document.createElement('div'); tools.className='toolbar';
  const refreshBtn = document.createElement('button'); refreshBtn.className='btn btn-outline'; refreshBtn.textContent='再読み込み';
  tools.append(refreshBtn);
  container.appendChild(tools);

  const listWrap = document.createElement('div'); listWrap.appendChild(loader());
  container.appendChild(listWrap);
  appRoot.replaceChildren(container);

  // ペンディング取得（最新順）
  let qy = query(
    collection(db,"submissions"),
    where("status","==","pending"),
    orderBy("createdAt","desc"),
    limit(50)
  );
  let snap;
  try{
    snap = await getDocs(qy);
  }catch(e){
    // インデックス未作成などの保険
    qy = query(collection(db,"submissions"), where("status","==","pending"), limit(50));
    snap = await getDocs(qy);
  }

  if(snap.empty){
    const empty = document.createElement('div'); empty.className='empty';
    empty.textContent = '審査待ちはありません。';
    listWrap.replaceChildren(empty);
    return;
  }

  const list = document.createElement('div'); list.className='list';

  for(const d of snap.docs){
    const r = { id:d.id, ...d.data() };

    const card = document.createElement('div'); card.className='card';
    const h3 = document.createElement('h3'); h3.textContent = r.name;
    const meta = document.createElement('div'); meta.className='meta';
    meta.innerHTML = `
      <span class="badge">${r.pref}</span>
      <div>${r.address??""}</div>
      ${r.note?`<div>${r.note}</div>`:""}
      <div class="muted">submittedBy: ${r.submittedByEmail || r.submittedByUid || "-"}</div>
    `;

    const actions = document.createElement('div'); actions.className='actions';

    const approve = document.createElement('button'); approve.className='btn btn-primary'; approve.textContent='承認して公開';
    approve.onclick = async ()=>{
      try{
        approve.disabled = true;
        await adminApproveSubmission(r);
        alert('公開しました（shopsに追加）');
        render(); // リスト再描画
      }catch(e){
        approve.disabled = false;
        alert('承認に失敗：' + e.message);
      }
    };

    const reject = document.createElement('button'); reject.className='btn'; reject.textContent='却下';
    reject.onclick = async ()=>{
      const reason = prompt('却下理由（任意）', '重複/情報不足など'); if(reason===null) return;
      try{
        reject.disabled = true;
        await adminRejectSubmission(r, reason);
        alert('却下しました');
        render();
      }catch(e){
        reject.disabled = false;
        alert('却下に失敗：' + e.message);
      }
    };

    const map = document.createElement('a'); map.className='btn btn-outline';
    map.href = mapsLinkFromAddress(r.address??""); map.target="_blank"; map.rel="noopener";
    map.textContent='地図';

    actions.append(approve, reject, map);
    card.append(h3, meta, actions);
    list.appendChild(card);
  }
  listWrap.replaceChildren(list);

  refreshBtn.onclick = ()=>render();
}

// =========================
// Tabs
// =========================
document.getElementById('tabs').addEventListener('click', (e)=>{
  const btn = e.target.closest('button.tab');
  if(!btn) return;
  state.tab = btn.dataset.tab;
  render();
});

// 初期描画
render();

/* メモ：
 * - 管理者判定：getIdTokenResult().claims.admin で制御
 * - 承認: writeBatch で shops へ copy + submissions を approved に
 * - 却下: submissions.status を rejected
 * - shops は status: "published" のみ表示（既存UIそのまま）
 */
