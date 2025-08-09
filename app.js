// =========================
// Firebase SDK imports
// =========================
import { initializeApp } from "https://www.gstatic.com/firebasejs/10.12.5/firebase-app.js";
import {
  getAuth, GoogleAuthProvider, signInWithPopup, onAuthStateChanged, signOut
} from "https://www.gstatic.com/firebasejs/10.12.5/firebase-auth.js";
import {
  getFirestore, collection, doc, getDoc, getDocs, query, where, addDoc,
  setDoc, deleteDoc, serverTimestamp, orderBy
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

const PREFS = ["福岡","佐賀","長崎","熊本","大分","宮崎","鹿児島"];

let currentUser = null;
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
  render(); // ログイン状態でUIを更新（お気に入りなど）
});

// =========================
// Helpers
// =========================
function mapsLinkFromAddress(address){
  return `https://www.google.com/maps/search/?api=1&query=${encodeURIComponent(address)}`;
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

// =========================
/** Firestore: shops を県で取得（publishedのみ） */
// =========================
async function fetchShopsByPref(pref, keyword=""){
  const qCol = collection(db, "shops");
  // 県で絞り込み
  const q = query(qCol, where("pref","==",pref), where("status","==","published"));
  const snap = await getDocs(q);
  let rows = snap.docs.map(d=>({id:d.id, ...d.data()}));
  if(keyword){
    const ql = keyword.toLowerCase();
    rows = rows.filter(r=>{
      const s = (r.name + (r.address??"") + (r.note??"")).toLowerCase();
      return s.includes(ql);
    });
  }
  // 並び（任意）：店名昇順
  rows.sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  return rows;
}

// =========================
// Firestore: Favorites
// =========================
async function isFav(shopId){
  if(!currentUser) return false;
  const favRef = doc(db, "users", currentUser.uid, "favorites", shopId);
  const snap = await getDoc(favRef);
  return snap.exists();
}
async function toggleFav(shop){
  if(!currentUser){ alert("お気に入りはログインが必要です"); return; }
  const favRef = doc(db, "users", currentUser.uid, "favorites", shop.id);
  const snap = await getDoc(favRef);
  if(snap.exists()){
    await deleteDoc(favRef);
  }else{
    await setDoc(favRef, {
      shopRef: doc(db,"shops",shop.id),
      createdAt: serverTimestamp()
    });
  }
  // 再描画
  render();
}
async function fetchFavorites(){
  if(!currentUser) return [];
  const favCol = collection(db, "users", currentUser.uid, "favorites");
  const snap = await getDocs(favCol);
  const results = [];
  for(const d of snap.docs){
    const shopId = d.id;
    const sdoc = await getDoc(doc(db,"shops",shopId));
    if(sdoc.exists()){
      results.push({ id: shopId, ...sdoc.data() });
    }
  }
  // 店名昇順
  results.sort((a,b)=>(a.name||"").localeCompare(b.name||""));
  return results;
}

// =========================
// Firestore: Submissions（審査待ち）
// =========================
async function submitNewShop(model){
  await addDoc(collection(db, "submissions"), {
    ...model,
    status: "pending",
    submittedByUid: currentUser ? currentUser.uid : null,
    createdAt: serverTimestamp()
  });
}

// =========================
// Views
// =========================
async function render(){
  document.querySelectorAll('.tab').forEach(btn=>{
    btn.classList.toggle('active', btn.dataset.tab === state.tab);
  });

  if(state.tab === "home")  await renderHome();
  if(state.tab === "favorites") await renderFavorites();
  if(state.tab === "new")   renderNew();
}

// Home
async function renderHome(){
  const container = document.createElement('div');
  container.className = 'container';

  // 都道府県選択
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

  // リスト表示
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

    // データ読み込み
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
      favBtn.textContent = '☆ お気に入り';
      // 非同期で状態反映
      isFav(r.id).then(flag=>{
        favBtn.textContent = flag ? '★ お気に入り済' : '☆ お気に入り';
      });
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
  fav.textContent = '☆ お気に入り';
  isFav(shop.id).then(flag=>{ fav.textContent = flag ? '★ お気に入り済' : '☆ お気に入り'; });
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

// 新規登録（審査待ち）
function renderNew(){
  const container = document.createElement('div');
  container.className='container';

  const title = h2('新規登録（審査制）');
  const form = document.createElement('div'); form.className='form';

  const model = { pref:PREFS[0], name:"", address:"", note:"" };

  const rows = [
    {key:'pref', label:'都道府県', el: ()=>selectPref()},
    {key:'name', label:'店名', el: ()=>inputText('例）うどん処 ○○')},
    {key:'address', label:'住所', el: ()=>inputText('例）福岡市○○区…')},
    {key:'note', label:'メモ', el: ()=>inputText('任意：特徴など')}
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
    if(!model.name || !model.address){ alert('店名と住所は必須です'); return; }
    await submitNewShop(model).catch(e=>alert(e.message));
    alert('送信しました。審査後に掲載されます。');
    state.tab = 'home'; state.selectedPref = model.pref; render();
  };
  const cancel = document.createElement('button'); cancel.className='btn btn-outline'; cancel.textContent='キャンセル';
  cancel.onclick = ()=>{ state.tab='home'; render(); };
  actions.append(cancel,send);

  form.appendChild(actions);
  container.append(title,form);

  // 補助: 投稿時はログイン推奨
  if(!currentUser){
    const note = document.createElement('div');
    note.className = 'empty';
    note.textContent = '※ ログインすると投稿があなたのアカウントに紐づきます。';
    container.appendChild(note);
  }

  appRoot.replaceChildren(container);

  function inputText(ph){
    const i = document.createElement('input'); i.className='input'; i.placeholder=ph; return i;
  }
  function selectPref(){
    const s = document.createElement('select'); s.className='select';
    PREFS.forEach(p=>{ const o=document.createElement('option'); o.value=p; o.textContent=p; s.appendChild(o); });
    return s;
  }
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
