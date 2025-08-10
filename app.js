// =========================
// Firebase SDK (v10 modular)
// =========================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, query, where, addDoc,
  setDoc, deleteDoc, serverTimestamp, orderBy, onSnapshot, writeBatch, limit
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";

// --- あなたのFirebase設定に差し替え ---
const firebaseConfig = {
  apiKey: "YOUR_API_KEY",
  authDomain: "YOUR_PROJECT_ID.firebaseapp.com",
  projectId: "YOUR_PROJECT_ID"
};
// ---------------------------------------

const appFB = initializeApp(firebaseConfig);
const auth = getAuth(appFB);
const db   = getFirestore(appFB);

const PREFS = ["福岡","佐賀","長崎","熊本","大分","宮崎","鹿児島"];

let currentUser = null;
let state = {
  tab: "home",
  selectedPref: null,
  search: ""
};

const $ = sel => document.querySelector(sel);
const appRoot = $('#app');

// --------------------
// Auth UI
// --------------------
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
onAuthStateChanged(auth, (user)=>{
  currentUser = user;
  renderAuthArea();
  startWatchFavorites();
  render();
});

// --------------------
// Helpers
// --------------------
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
  // 重複検知用の簡易キー（全角→半角/空白削除/小文字化）
  return (str||"")
    .replace(/\s+/g,"")
    .replace(/[Ａ-Ｚａ-ｚ０-９]/g, s=>String.fromCharCode(s.charCodeAt(0)-0xFEE0))
    .toLowerCase();
}

// --------------------
// shops（公開データ）
// --------------------
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

// --------------------
// Favorites（効率版）
// --------------------
import { onSnapshot as onSnap } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-firestore.js";
let favUnsub = null;
let favSet = new Set(); // shopId の集合

function startWatchFavorites() {
  if (favUnsub) { favUnsub(); favUnsub=null; }
  if (!currentUser) { favSet = new Set(); return; }
  const col = collection(db, "users", currentUser.uid, "favorites");
  favUnsub = onSnap(col, snap => {
    favSet = new Set(snap.docs.map(d => d.id));
    // 画面の⭐を即時更新
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
    // ロールバック
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

// --------------------
// Submissions（新規登録）
//  - バリデーション
//  - 重複チェック（pref＋name/addressの簡易一致）
//  - レート制限（クライアントで60秒/回 + ペンディング上限）
//  - 自分の申請一覧の表示・編集（pendingのみ）・削除
// --------------------
const SUBMIT_COOLDOWN_MS = 60 * 1000; // 60s
const PENDING_LIMIT_PER_USER = 10;

function getLastSubmitTs(){
  try{ return Number(localStorage.getItem("udon_submit_lastts")||"0"); }catch(_e){ return 0; }
}
function setLastSubmitTs(ts){ try{ localStorage.setItem("udon_submit_lastts", String(ts)); }catch(_e){} }

async function hasPendingQuota(){
  if(!currentUser) return true; // 未ログインはクライアント側で弾くのでここは通る
  const qy = query(collection(db,"submissions"),
    where("submittedByUid","==", currentUser.uid),
    where("status","==","pending"),
    limit(PENDING_LIMIT_PER_USER)
  );
  const snap = await getDocs(qy);
  return snap.size < PENDING_LIMIT_PER_USER;
}

async function checkDuplicate(pref, name, address){
  // 既存shops（published）に同名 or 同住所があれば重複判定
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

  // レート制限（クライアント側）
  const last = getLastSubmitTs();
  if (now - last < SUBMIT_COOLDOWN_MS){
    const sec = Math.ceil((SUBMIT_COOLDOWN_MS - (now-last))/1000);
    throw new Error(`送信間隔が短すぎます。${sec}秒後に再度お試しください。`);
  }

  // ログイン推奨（未ログインでも受け付けたい場合はここを外す）
  if(!currentUser){
    throw new Error("申請はログインが必要です（審査状況の確認・編集のため）");
  }

  // ペンディング上限
  if(!(await hasPendingQuota())){
    throw new Error(`審査中の申請が上限（${PENDING_LIMIT_PER_USER}件）に達しています。結果が出るまでお待ちください。`);
  }

  // 重複チェック
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

// 自分の申請一覧（最新順）
async function fetchMySubmissions(){
  if(!currentUser) return [];
  const qy = query(
    collection(db,"submissions"),
    where("submittedByUid","==", currentUser.uid),
    orderBy("createdAt","desc")
  );
  const snap = await getDocs(qy);
  return snap.docs.map(d=>({ id:d.id, ...d.data() }));
}

// 申請編集（pendingのみ）
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

// 申請削除（pendingのみ）
async function deleteSubmission(id){
  const ref = doc(db,"submissions", id);
  const cur = await getDoc(ref);
  if(!cur.exists()) return;
  const data = cur.data();
  if(!currentUser || data.submittedByUid !== currentUser.uid) throw new Error("権限がありません");
  if(data.status !== "pending") throw new Error("審査中以外は削除できません");
  await deleteDoc(ref);
}

// --------------------
// Views
// --------------------
async function render(){
  document.querySelectorAll('.tab').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.tab === state.tab);
  });

  if(state.tab === "home")       await renderHome();
  if(state.tab === "favorites")  await renderFavorites();
  if(state.tab === "new")        await renderNew();
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

// 新規登録（審査制・実運用版）
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
      // クライアント側バリデーション
      if(!normalize(model.name) || !normalize(model.address)){
        alert('店名と住所は必須です'); return;
      }
      // 送信
      await submitNewShop(model);
      alert('送信しました。審査後に掲載されます。');
      // 送信後は自分の申請一覧を表示
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

  // 補助メッセージ
  if(!currentUser){
    const note = document.createElement('div');
    note.className = 'empty';
    note.textContent = '※ ログインすると申請の編集・削除ができ、審査状況も確認できます。';
    container.appendChild(note);
  }else{
    // 自分の申請一覧（同一画面内に表示）
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

// 自分の申請一覧UI（編集・削除対応）
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

  const rows = await fetchMySubmissions();
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

// --------------------
// Tabs
// --------------------
document.getElementById('tabs').addEventListener('click', (e)=>{
  const btn = e.target.closest('button.tab');
  if(!btn) return;
  state.tab = btn.dataset.tab;
  render();
});

// 初期描画
render();
