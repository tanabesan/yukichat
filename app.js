import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, addDoc, serverTimestamp, query, orderBy, limit, onSnapshot, doc, getDoc, getDocs, setDoc, updateDoc, arrayUnion, arrayRemove, deleteDoc, startAfter, where } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile, signOut, signInAnonymously, sendEmailVerification, linkWithCredential, EmailAuthProvider, reload, sendPasswordResetEmail } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getDatabase, ref as rtdbRef, set as rtdbSet, onValue, onDisconnect, serverTimestamp as rtdbServerTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const firebaseConfig = { apiKey: "AIzaSyA8X7HsOXDERBTy4GvLE8ibg3bk8JhldZg", authDomain: "chat-16746.firebaseapp.com", projectId: "chat-16746", storageBucket: "chat-16746.firebasestorage.app", messagingSenderId: "1009009975164", appId: "1:1009009975164:web:64192371271cb589614ef9" };
const app = initializeApp(firebaseConfig);
const rtdb = getDatabase(app);

// プッシュ通知表示用のService Workerを登録しておく。
// （new Notification() はAndroid Chromeでは"Illegal constructor"エラーになり動かないため、
//   Service Worker経由の showNotification() を優先的に使えるようにする）
let swRegistration = null;
if ('serviceWorker' in navigator) {
    navigator.serviceWorker.register('./sw.js')
        .then(reg => { swRegistration = reg; })
        .catch(err => console.error('[sw] 登録失敗（new Notification()にフォールバックします）', err));
}

// iOS Safari（特にプライベートブラウジングモード）ではIndexedDBが使えない/不安定なことがあり、
// persistentLocalCacheの初期化自体が失敗することがある。失敗した場合はオフラインキャッシュ無しで動かす。
let db;
try {
    db = initializeFirestore(app, {
        localCache: persistentLocalCache({tabManager: persistentMultipleTabManager()})
    });
} catch (e) {
    console.error('[firestore] persistentLocalCacheの初期化に失敗。メモリキャッシュで続行します', e);
    db = initializeFirestore(app, {});
}
const auth = getAuth(app);

// --- 通知音と設定用変数 ---
// ===== サウンドエンジン (Web Audio API) =====
const _audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function _resumeCtx() {
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
}

function _tone(freq, startTime, duration, volume = 0.4, type = 'sine', fadeIn = 0.01) {
    const osc  = _audioCtx.createOscillator();
    const gain = _audioCtx.createGain();
    osc.connect(gain);
    gain.connect(_audioCtx.destination);
    osc.frequency.value = freq;
    osc.type = type;
    gain.gain.setValueAtTime(0, startTime);
    gain.gain.linearRampToValueAtTime(volume, startTime + fadeIn);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    osc.start(startTime);
    osc.stop(startTime + duration + 0.05);
}

function _noise(startTime, duration, volume = 0.15) {
    const bufSize = _audioCtx.sampleRate * duration;
    const buf = _audioCtx.createBuffer(1, bufSize, _audioCtx.sampleRate);
    const data = buf.getChannelData(0);
    for (let i = 0; i < bufSize; i++) data[i] = Math.random() * 2 - 1;
    const src  = _audioCtx.createBufferSource();
    const gain = _audioCtx.createGain();
    const filter = _audioCtx.createBiquadFilter();
    filter.type = 'bandpass';
    filter.frequency.value = 800;
    src.buffer = buf;
    src.connect(filter);
    filter.connect(gain);
    gain.connect(_audioCtx.destination);
    gain.gain.setValueAtTime(volume, startTime);
    gain.gain.exponentialRampToValueAtTime(0.001, startTime + duration);
    src.start(startTime);
    src.stop(startTime + duration + 0.05);
}

function playNotifySound() {
    if (!isSoundEnabled) return;
    _resumeCtx();
    const t = _audioCtx.currentTime;
    _tone(880,  t,       0.10, 0.3, 'sine');
    _tone(1320, t+0.11,  0.10, 0.25, 'sine');
}

function playSlotSpinSound(duration) {
    if (!isSoundEnabled) return;
    _resumeCtx();
    const t = _audioCtx.currentTime;
    _noise(t, duration * 0.001, 0.2);
    for (let i = 0; i < 6; i++) {
        _tone(200 + Math.random()*100, t + i * duration * 0.00015, 0.04, 0.08, 'square');
    }
}

function playReelStopSound(reelIndex) {
    if (!isSoundEnabled) return;
    _resumeCtx();
    const t = _audioCtx.currentTime;
    const freq = [300, 340, 380][reelIndex] || 300;
    _tone(freq, t, 0.08, 0.35, 'triangle');
    _tone(freq * 0.5, t, 0.12, 0.2, 'sine');
}

function playReachSound() {
    if (!isSoundEnabled) return;
    _resumeCtx();
    const t = _audioCtx.currentTime;
    _tone(440, t,      0.08, 0.3, 'square');
    _tone(440, t+0.12, 0.08, 0.3, 'square');
    _tone(440, t+0.24, 0.08, 0.3, 'square');
    _tone(660, t+0.40, 0.15, 0.4, 'square');
}

function playWinSound() {
    if (!isSoundEnabled) return;
    _resumeCtx();
    const t = _audioCtx.currentTime;
    [523, 659, 784, 1047].forEach((f, i) => {
        _tone(f, t + i * 0.08, 0.15, 0.3, 'sine');
    });
}

function playJackpotSound() {
    if (!isSoundEnabled) return;
    _resumeCtx();
    const t = _audioCtx.currentTime;
    [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => {
        _tone(f, t + i * 0.07, 0.18, 0.35, 'sine');
    });
    for (let i = 0; i < 8; i++) {
        _tone(1200 + Math.random()*400, t + 0.5 + i*0.06, 0.06, 0.15, 'triangle');
    }
}

function playMissSound() {
    if (!isSoundEnabled) return;
    _resumeCtx();
    const t = _audioCtx.currentTime;
    _tone(220, t,      0.15, 0.3, 'sawtooth');
    _tone(180, t+0.18, 0.20, 0.3, 'sawtooth');
}

function playBoostedSound() {
    if (!isSoundEnabled) return;
    _resumeCtx();
    const t = _audioCtx.currentTime;
    [300, 400, 500, 700, 900].forEach((f, i) => {
        _tone(f, t + i * 0.06, 0.12, 0.3, 'square');
    });
}


let unreadCount = 0;
let unreadRooms = {};
let lastSeenTimestamps = {};
let lastFriendReqSeenAtMs = 0; // フレンド申請の既読ライン（Firestoreに保存し端末間で同期する）
let pendingFriendReqCount = 0; // 今の未処理（pending）フレンド申請数。サイドバーの赤バッジに使う
const NOTIF_KEYS = {
    soundChat:    'notif_sound_chat',
    soundDm:      'notif_sound_dm',
    soundFriendReq: 'notif_sound_friend_req',
    soundFriendAcc: 'notif_sound_friend_acc',
    pushChat:     'notif_push_chat',
    pushDm:       'notif_push_dm',
    pushFriendReq:'notif_push_friend_req',
    pushFriendAcc:'notif_push_friend_acc',
};

// アプリを見ている間（タブが表示されていて、かつフォーカスがある状態）は
// 通知音・プッシュ通知を一切出さないようにする設定。デフォルトはOFF（今まで通り常に鳴る）。
const NOTIF_MUTE_WHILE_OPEN_KEY = 'notif_mute_while_open';
function getMuteWhileOpen() {
    return localStorage.getItem(NOTIF_MUTE_WHILE_OPEN_KEY) === 'true';
}
function isAppActivelyOpen() {
    return document.visibilityState === 'visible' && document.hasFocus();
}

function getNotif(key) {
    const v = localStorage.getItem(NOTIF_KEYS[key]);
    return v === null ? true : v === 'true';
}
function setNotif(key, val) {
    localStorage.setItem(NOTIF_KEYS[key], val);
}

let isSoundEnabled = getNotif('soundChat');

const _notifyAudioEl = new Audio('https://tanabesan.github.io/yukichat/file/sound/%E9%80%9A%E7%9F%A5%E9%9F%B3.mp3');
_notifyAudioEl.volume = 0.6;
const notifyAudio = {
    play: () => { 
        _notifyAudioEl.currentTime = 0;
        return _notifyAudioEl.play().catch(() => {}); // 自動再生ポリシーでブロックされることがあるが、想定内なので無視する
    },
    currentTime: 0,
    volume: 0.6
};

// NOTIF_KEYSの各キーと、実際のチェックボックスIDの対応表
const NOTIF_CHECKBOX_IDS = {
    soundChat: 'soundChatMsg',
    soundDm: 'soundDmMsg',
    soundFriendReq: 'soundFriendReq',
    soundFriendAcc: 'soundFriendAcc',
    pushChat: 'pushChatMsg',
    pushDm: 'pushDmMsg',
    pushFriendReq: 'pushFriendReq',
    pushFriendAcc: 'pushFriendAcc',
};

function initNotifUI() {
    Object.keys(NOTIF_KEYS).forEach(key => {
        const $el = $('#' + NOTIF_CHECKBOX_IDS[key]);
        if ($el.length) $el.prop('checked', getNotif(key));
    });

    $('#muteWhileOpen').prop('checked', getMuteWhileOpen());
    $('#muteWhileOpen').on('change', function() {
        localStorage.setItem(NOTIF_MUTE_WHILE_OPEN_KEY, this.checked);
    });

    updatePushPermissionMsg();

    $('#soundChatMsg').on('change', function() { setNotif('soundChat', this.checked); isSoundEnabled = this.checked; });
    $('#soundDmMsg').on('change', function() { setNotif('soundDm', this.checked); });
    $('#soundFriendReq').on('change', function() { setNotif('soundFriendReq', this.checked); });
    $('#soundFriendAcc').on('change', function() { setNotif('soundFriendAcc', this.checked); });
    $('#pushChatMsg').on('change', function() { setNotif('pushChat', this.checked); });
    $('#pushDmMsg').on('change', function() { setNotif('pushDm', this.checked); });
    $('#pushFriendReq').on('change', function() { setNotif('pushFriendReq', this.checked); });
    $('#pushFriendAcc').on('change', function() { setNotif('pushFriendAcc', this.checked); });

    $('#testSoundBtn').on('click', () => notifyAudio.play());
}

function updatePushPermissionMsg() {
    const $msg = $('#notif-permission-msg');
    if (!('Notification' in window)) {
        $msg.text('このブラウザはプッシュ通知に対応していません');
    } else if (Notification.permission === 'granted') {
        $msg.text('✅ 通知が許可されています');
    } else if (Notification.permission === 'denied') {
        $msg.text('🚫 通知がブロックされています。ブラウザ設定から許可してください');
    } else {
        $msg.text('ボタンを押して通知を許可してください');
    }
}

function playNotifSound(type) {
    if (!getNotif(type)) return;
    if (getMuteWhileOpen() && isAppActivelyOpen()) return;
    notifyAudio.play();
}

function sendPushNotif(type, title, body, icon, tag) {
    if (!getNotif(type)) return;
    if (getMuteWhileOpen() && isAppActivelyOpen()) return;
    if (!('Notification' in window)) return;
    if (Notification.permission !== 'granted') return;

    // renotify:true が無いと、Edge/Chrome系は同じtagの通知を「アクションセンターで黙って上書き」
    // するだけになり、2回目以降トースト（ポップアップ）が出なくなる。これを防ぐ。
    const opts = { body, icon: icon || '/favicon.ico', tag, renotify: true };

    // Service Worker経由を優先（Android Chrome等では new Notification() が使えないため）
    if (swRegistration && swRegistration.showNotification) {
        swRegistration.showNotification(title, opts)
            .catch(err => {
                console.error('[push] SW経由での送信に失敗、new Notification()にフォールバック', err);
                try { new Notification(title, opts); } catch (e2) { console.error('[push] フォールバックも失敗', e2); }
            });
        return;
    }

    try {
        const n = new Notification(title, opts);
        n.onclick = () => window.focus();
        return n;
    } catch (error) {
        console.error('[push] new Notification()が失敗しました（Android Chromeではこの方式自体が非対応です）', error);
    }
}

function clearUnread() {
    const readKey = currentRoomId || "global";
    lastSeenTimestamps[readKey] = Date.now();
    localStorage.setItem('chat_last_seen_' + readKey, lastSeenTimestamps[readKey].toString());
    
    if(unreadRooms[readKey]) {
        delete unreadRooms[readKey];
        updateDMBadges();
    }
    
    recalculateTotalUnread();
    
}

function recalculateTotalUnread() {
    const total = Object.values(unreadRooms).reduce((sum, count) => sum + count, 0);
    unreadCount = total;
    
    if(unreadCount > 0) {
        document.title = `(${unreadCount}) ゆきちゃっと`;
        $("#menuToggle").addClass("badge-notify");
    } else {
        document.title = "ゆきちゃっと";
        $("#menuToggle").removeClass("badge-notify");
    }
}

function updateDMBadges() {
    Object.keys(unreadRooms).forEach(roomId => {
        const count = unreadRooms[roomId] || 0;
        const $dmItem = $(`.sidebar-item[data-room-id="${roomId}"]`);
        
        if(count > 0) {
            let $badge = $dmItem.find('.dm-unread-badge');
            if($badge.length === 0) {
                $dmItem.css('position', 'relative');
                $dmItem.prepend('<div class="dm-unread-badge"></div>');
                $badge = $dmItem.find('.dm-unread-badge');
            }
            $badge.text(count > 9 ? '9+' : count).show();
        } else {
            $dmItem.find('.dm-unread-badge').remove();
        }
    });
}
// -----------------------

const CLOUD_NAME = "DD17U0VMA", UPLOAD_PRESET = "my_chat_preset";
const DEFAULT_AVATAR = "https://www.w3schools.com/howto/img_avatar.png";
const DEFAULT_BANNER = "https://images.unsplash.com/photo-1614850523296-d8c1af93d400?auto=format&fit=crop&w=1000";

function escapeHTML(str) {
    if (!str) return "";
    return str.replace(/[&<>"']/g, function(m) {
        return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[m];
    });
}

// 無料スタンプ（誰でも使える）
const FREE_STAMP_LIST = [
    "https://fonts.gstatic.com/s/e/notoemoji/latest/1f600/512.webp",
    "https://fonts.gstatic.com/s/e/notoemoji/latest/1f60d/512.webp",
    "https://fonts.gstatic.com/s/e/notoemoji/latest/1f62d/512.webp",
    "https://fonts.gstatic.com/s/e/notoemoji/latest/1f602/512.webp",
    "https://fonts.gstatic.com/s/e/notoemoji/latest/1f44d/512.webp",
    "https://fonts.gstatic.com/s/e/notoemoji/latest/1f525/512.webp",
    "https://fonts.gstatic.com/s/e/notoemoji/latest/1f389/512.webp",
    "https://fonts.gstatic.com/s/e/notoemoji/latest/1f4af/512.webp"
];

// 公式スタンプパック（LINEのスタンプショップのように、複数個まとめ売り。ownedPacksにidが入っていれば所持中）
// stamps は {url, name} の配列。thumbnailはパック一覧に出すサムネイル（未指定ならstamps[0].urlを使う）
const STAMP_PACKS = [
    {
        id: 'pack_emotion',
        name: '表情いろいろパック',
        description: 'ウインクやクールなど、日常づかいしやすい表情スタンプ5個入り',
        thumbnail: "https://fonts.gstatic.com/s/e/notoemoji/latest/1f609/512.webp",
        price: 100,
        stamps: [
            { url: "https://fonts.gstatic.com/s/e/notoemoji/latest/1f609/512.webp", name: 'ウインク' },
            { url: "https://fonts.gstatic.com/s/e/notoemoji/latest/1f60e/512.webp", name: 'クール' },
            { url: "https://fonts.gstatic.com/s/e/notoemoji/latest/1f60d/512.webp", name: 'ハート目' },
            { url: "https://fonts.gstatic.com/s/e/notoemoji/latest/1f47b/512.webp", name: 'おばけ' },
            { url: "https://fonts.gstatic.com/s/e/notoemoji/latest/1f47d/512.webp", name: 'エイリアン' },
        ]
    },
    {
        id: 'pack_party',
        name: 'お祝いパック',
        description: 'パーティーや誕生日、記念日にぴったりの豪華スタンプ3個入り',
        thumbnail: "https://fonts.gstatic.com/s/e/notoemoji/latest/1f973/512.webp",
        price: 90,
        stamps: [
            { url: "https://fonts.gstatic.com/s/e/notoemoji/latest/1f973/512.webp", name: 'パーティー' },
            { url: "https://fonts.gstatic.com/s/e/notoemoji/latest/1f48e/512.webp", name: 'ジェム' },
            { url: "https://fonts.gstatic.com/s/e/notoemoji/latest/1f451/512.webp", name: 'クラウン' },
        ]
    },
    {
        id: 'pack_space',
        name: '宇宙たびパック',
        description: 'ユニコーンとロケットの2個入りスペシャルパック',
        thumbnail: "https://fonts.gstatic.com/s/e/notoemoji/latest/1f984/512.webp",
        price: 60,
        stamps: [
            { url: "https://fonts.gstatic.com/s/e/notoemoji/latest/1f984/512.webp", name: 'ユニコーン' },
            { url: "https://fonts.gstatic.com/s/e/notoemoji/latest/1f680/512.webp", name: 'ロケット' },
        ]
    },
];

// 自作スタンプパック投稿のルール
const CUSTOM_PACK_MIN_STAMPS = 3;
const CUSTOM_PACK_MAX_STAMPS = 8;
const CUSTOM_PACK_MIN_PRICE = 20;
const CUSTOM_PACK_MAX_PRICE = 300;
// 投稿の乱用防止：クールダウンと、1人あたりの最大投稿数
const CUSTOM_PACK_SUBMIT_COOLDOWN_MS = 24 * 60 * 60 * 1000; // 24時間に1回まで
const CUSTOM_PACK_MAX_PER_USER = 5; // 1人が持てる自作パックは最大5個まで
const STAMP_REPORT_HIDE_THRESHOLD = 3; // この件数の通報が集まったら一覧から自動非表示

let pendingImageUrl = null, replyTarget = null, editTargetId = null, pc, localStream, currentCallId = null;
let currentRoomId = null;

// 管理者メールアドレス（Firestoreルールのisadmin()と合わせる）
const ADMIN_EMAILS = ['arinkodayo0204@gmail.com'];
let isCurrentUserAdmin = false;
let myBlockedUsers = [];
let currentDMOtherUid = null;
let currentUnsubscribe = null;
let globalUnsubscribers = [];
let friendIds = [];
// STUNだけでは互いに厳しいネットワーク（モバイル回線・企業/学校ネットワーク等）にいると接続できないため、
// 中継役のTURNサーバーも用意する。
// 下記は無料公開デモ用のTURN（Open Relay Project / metered.ca）。共有の無料枠なので、
// 利用者が増えて不安定になったら https://www.metered.ca/tools/openrelay/ 等で自分専用の認証情報を取得すること。
const servers = {
    iceServers: [
        { urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] },
        {
            urls: 'turn:openrelay.metered.ca:80',
            username: 'openrelayproject',
            credential: 'openrelayproject',
        },
        {
            urls: 'turn:openrelay.metered.ca:443',
            username: 'openrelayproject',
            credential: 'openrelayproject',
        },
        {
            urls: 'turn:openrelay.metered.ca:443?transport=tcp',
            username: 'openrelayproject',
            credential: 'openrelayproject',
        },
    ],
};
let currentTab = 'all', usersCache = {}, isInitialLoad = true, lastRenderedMsgId = null;
let typingTimeout;

let lastVisibleDoc = null; 
let isFetchingMore = false;
let hasMoreMessages = true;
const PAGE_SIZE = 30;

async function baseUpload(file, isProfile = false, profileText = "画像をアップロード中") {
    if(!file || !file.type.startsWith('image/')) return null;
    
    if(isProfile) {
        $("#profile-upload-text").text(profileText);
        $("#profile-upload-status").removeClass("hidden");
    } else {
        $("#upload-status-indicator").removeClass("hidden");
    }
    
    $("#sendBtn, #saveProfile").prop("disabled", true).css("opacity", "0.5");
    const fd = new FormData();
    fd.append("file", file);
    fd.append("upload_preset", UPLOAD_PRESET);
    try {
        const res = await fetch(`https://api.cloudinary.com/v1_1/${CLOUD_NAME}/image/upload`, { method: "POST", body: fd });
        const data = await res.json(); 
        return data.secure_url;
    } catch (err) { 
        alert("アップロード失敗"); 
        return null;
    } finally {
        if(isProfile) {
            $("#profile-upload-status").addClass("hidden");
        } else {
            $("#upload-status-indicator").addClass("hidden");
        }
        $("#sendBtn, #saveProfile").prop("disabled", false).css("opacity", "1");
    }
}

async function uploadImageFile(file) {
    const url = await baseUpload(file);
    if(url) {
        pendingImageUrl = url;
        $("#img-preview-src").attr("src", pendingImageUrl); 
        $("#upload-preview-container").removeClass("hidden");
    }
    $("#real_file_input").val("");
}

async function uploadAvatarFile(file) {
    const url = await baseUpload(file, true, "アイコンをアップロード中");
    if(url) {
        $("#editPhoto").val(url);
        syncProfilePreview();
    }
    $("#real_avatar_input").val("");
}

async function uploadBannerFile(file) {
    const url = await baseUpload(file, true, "バナーをアップロード中");
    if(url) {
        $("#editBanner").val(url);
        syncProfilePreview();
    }
    $("#real_banner_input").val("");
}

const $chatInputArea = $("#chat-input-area");
$(document).on("dragover", (e) => { e.preventDefault(); $chatInputArea.addClass("drag-over"); });
$(document).on("dragleave drop", (e) => { e.preventDefault(); $chatInputArea.removeClass("drag-over"); });
$(document).on("drop", (e) => {
    const files = e.originalEvent.dataTransfer.files;
    if (files.length > 0) uploadImageFile(files[0]);
});

$("#messageInput").on("paste", (e) => {
    const items = (e.clipboardData || e.originalEvent.clipboardData).items;
    for (let i = 0; i < items.length; i++) {
        if (items[i].type.indexOf("image") !== -1) {
            const blob = items[i].getAsFile();
            uploadImageFile(blob);
        }
    }
});

window.toggleSidebar = (show) => {
    if(show) {
        $("#sidebar").addClass("open");
        $("#sidebar-overlay").fadeIn(200);
        updateSidebarDMList();
        restoreSidebarGroupState();
    } else {
        $("#sidebar").removeClass("open");
        $("#sidebar-overlay").fadeOut(200);
    }
};
$("#menuToggle, #sidebar-overlay").on("click", () => toggleSidebar(!$("#sidebar").hasClass("open")));

// サイドバーのカテゴリ（ゲーム＆特典・ダイレクトメッセージ）の開閉。状態はlocalStorageに保存し、
// リロード後や次回開いた時も前回の開閉状態を覚えておく。
const SIDEBAR_COLLAPSED_KEY = 'sidebar_collapsed_groups';

window.toggleSidebarGroup = (groupName) => {
    const $group = $(`.sidebar-group[data-group="${groupName}"]`);
    const isCollapsed = $group.toggleClass('collapsed').hasClass('collapsed');

    let collapsed = JSON.parse(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) || '[]');
    if (isCollapsed) {
        if (!collapsed.includes(groupName)) collapsed.push(groupName);
    } else {
        collapsed = collapsed.filter(g => g !== groupName);
    }
    localStorage.setItem(SIDEBAR_COLLAPSED_KEY, JSON.stringify(collapsed));
};

function restoreSidebarGroupState() {
    const collapsed = JSON.parse(localStorage.getItem(SIDEBAR_COLLAPSED_KEY) || '[]');
    collapsed.forEach(groupName => {
        $(`.sidebar-group[data-group="${groupName}"]`).addClass('collapsed');
    });
}
restoreSidebarGroupState();

async function updateSidebarDMList() {
    const $dmList = $("#dm-list").empty();
    if(friendIds.length === 0) {
        $dmList.append('<div style="padding:10px; font-size:12px; color:var(--txt-m);">フレンドがいません</div>');
        return;
    }
    friendIds.forEach(fid => {
        const u = usersCache[fid];
        if(!u) return;
        const roomId = [auth.currentUser.uid, fid].sort().join("_");
        const activeClass = currentRoomId === roomId ? 'active' : '';
        const statusClass = getUserOnlineStatus(fid);
        const unreadCount = unreadRooms[roomId] || 0;
        const badgeHtml = unreadCount > 0 ? `<div class="dm-unread-badge">${unreadCount > 9 ? '9+' : unreadCount}</div>` : '';
        
        $dmList.append(`
            <div class="sidebar-item ${activeClass}" onclick="openDM('${fid}','${escapeHTML(u.name)}')" data-user-id="${fid}" data-room-id="${roomId}" style="position: relative;">
                ${badgeHtml}
                <div class="icon-container">
                    <img src="${u.photo || DEFAULT_AVATAR}" style="width:24px; height:24px; border-radius:50%; object-fit:cover;">
                    <div class="status-dot ${statusClass}"></div>
                </div>
                <span style="font-size:14px;">${escapeHTML(u.name)}</span>
            </div>
        `);
    });
}

function scrollToBottom(force = false) {
    if (isLoadingMoreMessages) return;
    const $box = $("#messages");
    if ($box.length === 0) return;
    const threshold = 200;
    const isAtBottom = ($box[0].scrollHeight - $box.scrollTop() <= $box[0].clientHeight + threshold);
    if (force || isAtBottom) {
        requestAnimationFrame(() => {
            requestAnimationFrame(() => {
                $box[0].scrollTop = $box[0].scrollHeight;
            });
        });
    }
}
window.scrollToBottom = scrollToBottom;

onAuthStateChanged(auth, async (user) => {
    $("#init-loader").fadeOut();
    $("#app-wrapper").addClass("visible");

    // メール未認証のアカウントは、ここで即座に弾く。
    // これより後（initPresence等）を一切実行させないのがポイント。
    // 以前は「ログインボタン側でemailVerifiedをチェックしてsignOutする」実装だったため、
    // signOutが完了するまでの一瞬だけonAuthStateChanged(user)が先に走ってオンライン状態が
    // RTDBに書き込まれてしまい、タイミング次第でオフラインに戻す処理と競合して
    // オンラインのまま残り続けてしまう「無限オンラインバグ」が起きていた。
    //
    // ただし user.emailVerified はブラウザ側にキャッシュされた古い情報のことがあり、
    // 別デバイス/別タブで認証を済ませていても、このセッションのキャッシュが古いままだと
    // 実際は認証済みなのに「未認証」と誤判定してサインアウトさせてしまうことがあった
    // （＝急に認証エラーになる不具合）。なので判定前に必ずreload()して最新状態を取得する。
    if (user && !user.isAnonymous && !user.emailVerified) {
        try {
            await reload(user);
        } catch (e) {
            console.error('[auth] emailVerified再確認のためのreloadに失敗', e);
        }
    }
    if (user && !user.isAnonymous && !user.emailVerified) {
        await signOut(auth);
        $("#app-wrapper").removeClass("visible");
        $("#auth-container").removeClass("hidden");
        switchAuthTab('login');
        return;
    }

    if (user) {
        const keys = Object.keys(localStorage);
        keys.forEach(key => {
            if(key.startsWith('chat_last_seen_')) {
                const roomKey = key.replace('chat_last_seen_', '');
                const timestamp = parseInt(localStorage.getItem(key));
                if(!isNaN(timestamp)) {
                    lastSeenTimestamps[roomKey] = timestamp;
                }
            }
        });
        
        if (user.isAnonymous) {
            const exp = new Date(); 
            exp.setDate(exp.getDate() + 30);
            
            const uRef = doc(db, "users", user.uid);
            const s = await getDoc(uRef);
            if(!s.exists()) {
                await setDoc(uRef, { name: "ゲスト", photo: DEFAULT_AVATAR, isTyping: false, expireAt: exp, isAnonymous: true });
            } else {
                await updateDoc(uRef, { expireAt: exp, isAnonymous: true });
            }
        }

        initPresence(user.uid);
        $("#auth-container").addClass("hidden");
        $("#app-wrapper").addClass("visible");
        $("#myName").text(user.displayName || "ゲスト");
        $("#myIconContainer").html(`<div class="icon-container"><img src="${user.photoURL || DEFAULT_AVATAR}" style="width:32px; height:32px; border-radius:50%; object-fit:cover;"><div class="status-dot online"></div></div>`);

        isCurrentUserAdmin = !!(user.email && ADMIN_EMAILS.includes(user.email));
        if (isCurrentUserAdmin) { $(".admin-only").removeClass("hidden"); }

        try {
            const myDoc = await getDoc(doc(db, "users", user.uid));
            if (myDoc.exists()) {
                myBlockedUsers = myDoc.data().blockedUsers || [];
                window.__isBanned = !!myDoc.data().banned;
                const seenTs = myDoc.data().lastFriendReqSeenAt;
                lastFriendReqSeenAtMs = seenTs ? seenTs.toDate().getTime() : 0;
                if (window.__isBanned) {
                    alert('🚫 このアカウントは利用停止されています。運営にお問い合わせください。');
                }
            }
        } catch (error) {
            console.error('Load blocked users error:', error);
        }
        
        if (user.displayName === "ゲスト" || !user.displayName) {
            $("#guest-warning-banner").show();
        }
        
        if (!user.isAnonymous) {
            const canClaim = await checkLoginBonus();
            if (canClaim) {
                setTimeout(() => {
                    openLoginBonusModal();
                }, 3000);
            }
        }
        
        applyUserTheme();
        
        updateNotificationButtonUI();
        
        const unsubFriends = onSnapshot(collection(db, "friendRequests"), (snap) => {
            friendIds = [];
            
            snap.docChanges().forEach(change => {
                const data = change.doc.data();
                const reqId = change.doc.id;
                
                if (change.type === "added" && data.to === user.uid && data.status === "pending") {
                    const senderData = usersCache[data.from];
                    const senderName = senderData ? senderData.name : "ゲスト";
                    const senderPhoto = senderData ? senderData.photo : DEFAULT_AVATAR;

                    // createdAtが既読ラインより新しい申請だけ通知する。
                    // （こうしないと、他の端末で開いた時に「もう見た申請」まで毎回鳴ってしまう）
                    const reqTime = data.createdAt ? data.createdAt.toDate().getTime() : 0;
                    if (reqTime > lastFriendReqSeenAtMs) {
                        triggerBadge("friend_request_" + reqId);
                        playNotifSound('soundFriendReq');
                        sendPushNotif('pushFriendReq', '新しいフレンド申請', `${senderName}さんからフレンド申請が届きました`, senderPhoto, 'friend-request-' + reqId);
                    }
                }
                
                if (change.type === "modified" && data.from === user.uid && data.status === "accepted") {
                    const accepterData = usersCache[data.to];
                    const accepterName = accepterData ? accepterData.name : "ゲスト";
                    const accepterPhoto = accepterData ? accepterData.photo : DEFAULT_AVATAR;
                    
                    playNotifSound('soundFriendAcc');
                    sendPushNotif('pushFriendAcc', 'フレンド申請が承認されました', `${accepterName}さんがフレンド申請を承認しました`, accepterPhoto, 'friend-accepted-' + reqId);
                    
                }
            });
            
            snap.forEach(d => {
                const data = d.data();
                if (data.status === "accepted") {
                    if (data.from === user.uid) friendIds.push(data.to);
                    if (data.to === user.uid) friendIds.push(data.from);
                }
            });

            // 未処理（pending）のフレンド申請数を常に数え直し、サイドバーの赤バッジに反映する
            pendingFriendReqCount = 0;
            snap.forEach(d => {
                const data = d.data();
                if (data.to === user.uid && data.status === "pending") pendingFriendReqCount++;
            });
            updateFriendReqSidebarBadge();

            if ($("#sidebar").hasClass("open")) updateSidebarDMList();
        });

        const unsubUsers = onSnapshot(collection(db, "users"), (snap) => {
            // usersCacheはdocChangesの差分だけで更新する（キャッシュとしては差分更新でOK）
            snap.docChanges().forEach(change => {
                const uid = change.doc.id;
                usersCache[uid] = change.doc.data();
            });

            // 「入力中」の表示は、差分だけでなく毎回usersCache全体から作り直す
            // （差分だけで判定すると、無関係な他ユーザーの変化で表示が古いまま残ったり消えたりするバグになるため）
            let typingNames = [];
            Object.keys(usersCache).forEach(uid => {
                const userData = usersCache[uid];
                if (uid !== auth.currentUser.uid && userData?.isTyping) {
                    typingNames.push(userData.name || "ゲスト");
                }
            });

            if(typingNames.length > 0) {
                $("#typing-indicator").text(typingNames.map(n => escapeHTML(n)).join(", ") + " が入力中...").removeClass("hidden");
            } else {
                $("#typing-indicator").addClass("hidden");
            }
        });

        const unsubRooms = onSnapshot(query(collection(db, "rooms"), where("users", "array-contains", user.uid)), (snap) => {
            snap.docChanges().forEach(change => {
                if(change.type === "modified" || change.type === "added") {
                    const d = change.doc.data();
                    const roomId = change.doc.id;
                    
                    if (d.updatedBy && d.updatedBy !== user.uid && roomId !== currentRoomId) {
                        const lastSeen = lastSeenTimestamps[roomId] || 0;
                        const updatedTime = d.updatedAt ? d.updatedAt.toMillis() : Date.now();
                        
                        if(updatedTime > lastSeen) {
                            triggerBadge(roomId);

                            // ここが重要：今開いていないDMの新着は、今までバッジが増えるだけで
                            // 音もプッシュ通知も一切鳴っていなかった（該当ルームを開いている時にしか
                            // 通知ロジックが動かない作りだったため）。ここで拾って鳴らす。
                            const senderData = usersCache[d.updatedBy];
                            const senderName = senderData ? (senderData.name || "ゲスト") : "ゲスト";
                            const senderPhoto = senderData ? (senderData.photo || DEFAULT_AVATAR) : DEFAULT_AVATAR;

                            playNotifSound('soundDm');
                            sendPushNotif('pushDm', `DM: ${senderName}`, d.lastMessage || "新着メッセージ", senderPhoto, 'dm-room-' + roomId);
                        }
                    }
                }
            });
            
            if ($("#sidebar").hasClass("open")) {
                updateSidebarDMList();
            }
        });

        globalUnsubscribers.push(unsubFriends, unsubUsers, unsubRooms);

        // パブリックチャットの新着を、DM側にいる時でも拾うための常時リスナー。
        // （今までは「パブリックチャットを開いている時」しか新着を検知できず、
        //   DMを見ている間にグローバルへ投稿があっても完全に無反応だった）
        let isFirstGlobalSnapshot = true;
        const unsubGlobalWatch = onSnapshot(
            query(collection(db, "chats"), orderBy("createdAt", "desc"), limit(1)),
            (snap) => {
                if (isFirstGlobalSnapshot) { isFirstGlobalSnapshot = false; return; }
                if (snap.empty || currentRoomId === null) return; // グローバルを見ている時は専用リスナー側で処理済み

                const lastDoc = snap.docs[0];
                const d = lastDoc.data();
                if (!d.uid || d.uid === auth.currentUser.uid) return;

                const lastSeen = lastSeenTimestamps["global"] || 0;
                const msgTime = d.createdAt ? d.createdAt.toMillis() : Date.now();
                if (msgTime <= lastSeen) return;

                triggerBadge("global");
                playNotifSound('soundChat');
                sendPushNotif('pushChat', `新着: ${d.name || "ゲスト"}`, d.text || (d.stamp ? "スタンプ" : "画像"), d.photo || DEFAULT_AVATAR, 'global-chat-msg');
            }
        );
        globalUnsubscribers.push(unsubGlobalWatch);
        switchChat(null);
        listenForCalls();
        initStampPicker();
    } else {
        $("#app-wrapper").removeClass("visible");
        $("#auth-container").removeClass("hidden");
        globalUnsubscribers.forEach(unsub => unsub());
        globalUnsubscribers = [];
        // 自動ログアウト・トークン失効などでユーザーがいなくなった場合も、
        // 直前まで自分だったuidのオンライン状態を明示的にoffline化する
        clearPresenceOnSignedOut();
    }
});

const syncProfilePreview = () => {
    $("#editPreviewName").text($("#editName").val() || "ゲスト");
    $("#editPreviewAvatar").attr("src", $("#editPhoto").val() || DEFAULT_AVATAR);
    $("#editPreviewBanner").attr("src", $("#editBanner").val() || DEFAULT_BANNER);
    $("#editPreviewBio").text($("#editBio").val() || "自己紹介はまだありません。");
    
    const selectedEffect = $("#editEquippedEffect").val();
    $("#editPreviewAvatarContainer").removeClass('effect-fire effect-sparkle effect-lightning effect-rainbow effect-shadow effect-ice effect-toxic effect-gold');
    
    if (selectedEffect === 'fire_effect') $("#editPreviewAvatarContainer").addClass('effect-fire');
    else if (selectedEffect === 'sparkle_effect') $("#editPreviewAvatarContainer").addClass('effect-sparkle');
    else if (selectedEffect === 'lightning_effect') $("#editPreviewAvatarContainer").addClass('effect-lightning');
    else if (selectedEffect === 'rainbow_effect') $("#editPreviewAvatarContainer").addClass('effect-rainbow');
    else if (selectedEffect === 'shadow_effect') $("#editPreviewAvatarContainer").addClass('effect-shadow');
    else if (selectedEffect === 'ice_effect') $("#editPreviewAvatarContainer").addClass('effect-ice');
    else if (selectedEffect === 'toxic_effect') $("#editPreviewAvatarContainer").addClass('effect-toxic');
    else if (selectedEffect === 'gold_effect') $("#editPreviewAvatarContainer").addClass('effect-gold');
    
    const selectedBadge = $("#editEquippedBadge").val();
    const $badgePreview = $("#editPreviewBadge").empty();
    const previewBadgeMap = {
        'vip_badge': { msIcon: 'workspace_premium', tileColor: '#ffd700', title: 'VIP' },
        'star_badge': { msIcon: 'star', tileColor: '#ffd700', title: 'スター' },
        'crown_badge': { msIcon: 'crown', tileColor: '#ffca28', title: 'プレミアム' }
    };
    if (previewBadgeMap[selectedBadge]) {
        const badge = previewBadgeMap[selectedBadge];
        $badgePreview.html(`<span class="user-badge" title="${badge.title}"><span class="sidebar-icon-tile tile-xs" style="--tile-color:${badge.tileColor};"><span class="material-symbols-outlined">${badge.msIcon}</span></span></span>`);
    }

    // 実際のプロフィール画面と同じ「好きな曲」カードをプレビューにも出す（区切り線ごと）
    const favoriteSongUrl = $("#editFavoriteSong").val().trim();
    if (favoriteSongUrl) {
        $("#editPreviewFavoriteSongSection").removeClass("hidden");
        renderSpotifySongCard(favoriteSongUrl, $("#editPreviewFavoriteSong"));
    } else {
        $("#editPreviewFavoriteSongSection").addClass("hidden");
    }
};
$("#editName, #editPhoto, #editBanner, #editBio, #editEquippedEffect, #editEquippedBadge").on("input change", syncProfilePreview);

let favoriteSongDebounce;
$("#editFavoriteSong").on("input", function() {
    clearTimeout(favoriteSongDebounce);
    const url = $(this).val().trim();
    favoriteSongDebounce = setTimeout(() => {
        renderSpotifyEmbed(url, $("#editFavoriteSongPreview"));
        syncProfilePreview();
    }, 600);
});

window.switchChat = (roomId, otherName = null, otherUid = null) => {
    currentRoomId = roomId;
    currentDMOtherUid = otherUid;
    isInitialLoad = true;
    lastRenderedMsgId = null;
    lastVisibleDoc = null;
    hasMoreMessages = true;
    $("#messages").empty();
    if (currentUnsubscribe) currentUnsubscribe();
    $(".sidebar-item").removeClass("active");
    if(!roomId) $(".sidebar-item:first").addClass("active");

    const colRef = roomId ? collection(db, "rooms", roomId, "messages") : collection(db, "chats");
    if (roomId) {
        $("#headerTitle").text(otherName + " とのDM");
        $("#callDMBtn").removeClass("hidden");
    } else {
        $("#headerTitle").text("パブリックチャット");
        $("#callDMBtn").addClass("hidden");
    }

    const msgQuery = query(colRef, orderBy("createdAt", "desc"), limit(PAGE_SIZE));
    currentUnsubscribe = onSnapshot(msgQuery, (snap) => {
        if (isInitialLoad && !snap.empty) {
            lastVisibleDoc = snap.docs[snap.docs.length - 1];
        }
        renderMessages(snap, true);
        if(isInitialLoad) {
            setTimeout(() => {
                if(document.hasFocus() && document.visibilityState === 'visible') {
                    clearUnread();
                }
            }, 500);
        }
    });
};

let isLoadingMoreMessages = false;
let pauseSnapshot = false;

function debounce(func, wait) {
    let timeout;
    return function executedFunction(...args) {
        const later = () => {
            clearTimeout(timeout);
            func(...args);
        };
        clearTimeout(timeout);
        timeout = setTimeout(later, wait);
    };
}

async function loadMoreMessages() {
    if (isFetchingMore || !hasMoreMessages || !lastVisibleDoc) return;
    isFetchingMore = true;
    isLoadingMoreMessages = true;
    pauseSnapshot = true;
    
    const $box = $("#messages");
    
    const firstVisibleMessage = $box.children().first()[0];
    const firstMessageId = firstVisibleMessage ? firstVisibleMessage.id : null;
    
    
    $("#messages").prepend('<div id="load-more-indicator">過去のメッセージを読み込み中...</div>');
    const colRef = currentRoomId ? collection(db, "rooms", currentRoomId, "messages") : collection(db, "chats");
    const nextQuery = query(colRef, orderBy("createdAt", "desc"), startAfter(lastVisibleDoc), limit(PAGE_SIZE));
    try {
        const snap = await getDocs(nextQuery);
        $("#load-more-indicator").remove();
        if (snap.empty) { 
            hasMoreMessages = false; 
            isFetchingMore = false; 
            isLoadingMoreMessages = false; 
            pauseSnapshot = false;
            return; 
        }
        lastVisibleDoc = snap.docs[snap.docs.length - 1];
        if (snap.size < PAGE_SIZE) hasMoreMessages = false;
        let html = "";
        let docs = [];
        snap.forEach(d => docs.push({id: d.id, data: d.data()}));
        docs.reverse();
        const groupedFlags = computeGroupedFlags(docs);
        docs.forEach((item, idx) => { html += generateMessageHtml(item.id, item.data, groupedFlags[idx]); });
        $("#messages").prepend(html);
        triggerLinkPreviews(docs);

        // 直前まで先頭だったメッセージが、今読み込んだ古いメッセージと同一グループになる場合はグループ化する
        if (firstVisibleMessage && docs.length > 0) {
            const lastOlder = docs[docs.length - 1].data;
            const boundaryUid = firstVisibleMessage.dataset.uid;
            const boundaryTimeMs = parseInt(firstVisibleMessage.dataset.timeMs || '0', 10);
            const lastOlderTimeMs = lastOlder.createdAt?.toMillis ? lastOlder.createdAt.toMillis() : Date.now();
            const shouldGroup = lastOlder.uid === boundaryUid && Math.abs(boundaryTimeMs - lastOlderTimeMs) <= GROUP_WINDOW_MS;
            if (shouldGroup) {
                $(firstVisibleMessage).addClass('grouped');
            }
        }
        
        if (firstMessageId) {
            const firstMessageElement = document.getElementById(firstMessageId);
            if (firstMessageElement) {
                firstMessageElement.scrollIntoView({ block: 'start', behavior: 'instant' });
            }
        }
        
        
    } catch (err) { console.error("Load more error:", err); } 
    finally { 
        isFetchingMore = false;
        setTimeout(() => {
            isLoadingMoreMessages = false;
            pauseSnapshot = false;
        }, 1500);
    }
}

// 直前のメッセージと同じ投稿者・10分以内かどうかを判定し、まとめて表示するためのフラグ配列を作る
const GROUP_WINDOW_MS = 10 * 60 * 1000;
function computeGroupedFlags(docsAsc) {
    return docsAsc.map((item, idx) => {
        if (idx === 0) return false;
        const prev = docsAsc[idx - 1].data;
        const curr = item.data;
        if (prev.uid !== curr.uid) return false;
        const prevTime = prev.createdAt?.toMillis ? prev.createdAt.toMillis() : Date.now();
        const currTime = curr.createdAt?.toMillis ? curr.createdAt.toMillis() : Date.now();
        return Math.abs(currTime - prevTime) <= GROUP_WINDOW_MS;
    });
}

// ===== リンクプレビュー（Cloud Functions不要、公開APIを直接利用） =====
// microlink.io の無料公開エンドポイント。CORS対応済みでブラウザから直接呼べる。
// 無料枠のレート制限があるため、同一URLはキャッシュして再取得しない。
const LINK_PREVIEW_API_URL = "https://api.microlink.io/";

// YouTubeは公開のoEmbed APIを使う（microlinkの無料枠だとボット対策で取得できないため）
const YOUTUBE_URL_REGEX = /^https?:\/\/(www\.)?(youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)/i;

// GitHubも一般的なスクレイパーがブロックされがちなので、公開REST APIから直接取る
const GITHUB_REPO_REGEX = /^https?:\/\/(www\.)?github\.com\/([^\/?#]+)\/([^\/?#]+)/i;

// ===== プロフィールの「好きな曲」（Spotify oEmbed。APIキー不要・OAuth不要） =====
const spotifyEmbedCache = {}; // url -> {html, title, thumbnail_url}

async function fetchSpotifyOembed(url) {
    if (spotifyEmbedCache[url]) return spotifyEmbedCache[url];
    const res = await fetch(`https://open.spotify.com/oembed?url=${encodeURIComponent(url)}`);
    if (!res.ok) throw new Error('spotify oembed failed: ' + res.status);
    const data = await res.json();
    if (!data.html) throw new Error('no embed html');
    spotifyEmbedCache[url] = data;
    return data;
}

// 編集画面のライブプレビュー用：その場で埋め込みプレイヤーをそのまま表示する
async function renderSpotifyEmbed(url, $container) {
    if (!url) { $container.empty(); return; }
    if (!/^https:\/\/open\.spotify\.com\//i.test(url)) {
        $container.html('<div style="font-size:11px; color:var(--danger);">Spotifyの共有リンク（open.spotify.com/...）を入力してください</div>');
        return;
    }
    $container.html('<div style="font-size:11px; color:var(--txt-m);">読み込み中...</div>');
    try {
        const data = await fetchSpotifyOembed(url);
        $container.html(data.html);
    } catch (e) {
        console.error('[spotify-embed] 取得失敗', url, e);
        $container.html('<div style="font-size:11px; color:var(--danger);">読み込みに失敗しました（リンクが正しいか確認してください）</div>');
    }
}

// プロフィール表示用：埋め込みプレイヤーをその場に直接置かず、
// クリックすると常設のミニプレイヤー（#global-spotify-player）で再生するカードを表示する。
// これにより、他のプロフィールを開いても再生中の曲が止まらない。
async function renderSpotifySongCard(url, $container) {
    if (!url) { $container.empty(); return; }
    if (!/^https:\/\/open\.spotify\.com\//i.test(url)) {
        $container.html('<div style="font-size:11px; color:var(--danger);">Spotifyの共有リンクが正しくありません</div>');
        return;
    }
    $container.html('<div style="font-size:11px; color:var(--txt-m);">読み込み中...</div>');
    try {
        const data = await fetchSpotifyOembed(url);
        const safeUrl = url.replace(/'/g, "&#39;");
        $container.html(`
            <div class="song-card" onclick="playInGlobalPlayer('${safeUrl}')">
                ${data.thumbnail_url ? `<img src="${escapeHTML(data.thumbnail_url)}">` : ''}
                <div class="song-card-info">
                    <div class="song-card-title">${escapeHTML(data.title || 'この曲')}</div>
                    <div class="song-card-sub">▶ タップして再生（スマホは30秒プレビュー。フル再生はSpotifyで開いてください）</div>
                </div>
            </div>
        `);
    } catch (e) {
        console.error('[spotify-embed] 取得失敗', url, e);
        $container.html('<div style="font-size:11px; color:var(--danger);">読み込みに失敗しました</div>');
    }
}

window.playInGlobalPlayer = async (url) => {
    try {
        const data = await fetchSpotifyOembed(url);
        $('#gsp-title').text(data.title || '再生中');
        $('#gsp-embed-container').html(data.html);
        $('#gsp-open-link').attr('href', url);
        $('#global-spotify-player').removeClass('hidden');
    } catch (e) {
        console.error('[spotify-embed] 再生失敗', url, e);
    }
};

window.closeGlobalSpotifyPlayer = () => {
    $('#gsp-embed-container').empty(); // 中のiframeを消すことで再生も止まる
    $('#global-spotify-player').addClass('hidden');
};

// ===== 常設プレイヤーの位置移動・最小化 =====
(function() {
    const $player = $('#global-spotify-player');
    const $handle = $('#gsp-drag-handle');

    // 前回の位置を復元する
    const savedPos = JSON.parse(localStorage.getItem('gsp_position') || 'null');
    if (savedPos) {
        $player.css({
            left: savedPos.left + 'px',
            top: savedPos.top + 'px',
            right: 'auto',
            bottom: 'auto',
        });
    }
    if (localStorage.getItem('gsp_minimized') === 'true') {
        $player.addClass('minimized');
    }

    // 最小化トグル
    $('#gsp-minimize-btn').on('click', (e) => {
        e.stopPropagation();
        const isMin = $player.toggleClass('minimized').hasClass('minimized');
        localStorage.setItem('gsp_minimized', isMin);
    });

    // ドラッグで移動（PC:マウス / スマホ:タッチ 両対応）
    let dragging = false;
    let offsetX = 0, offsetY = 0;

    function onDragStart(clientX, clientY) {
        dragging = true;
        const rect = $player[0].getBoundingClientRect();
        offsetX = clientX - rect.left;
        offsetY = clientY - rect.top;
        $player.addClass('dragging');
    }

    function onDragMove(clientX, clientY) {
        if (!dragging) return;
        const rect = $player[0].getBoundingClientRect();
        let left = clientX - offsetX;
        let top = clientY - offsetY;
        // 画面外に出ないように制限する
        left = Math.max(4, Math.min(window.innerWidth - rect.width - 4, left));
        top = Math.max(4, Math.min(window.innerHeight - 40, top));
        $player.css({ left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' });
    }

    function onDragEnd() {
        if (!dragging) return;
        dragging = false;
        $player.removeClass('dragging');
        const rect = $player[0].getBoundingClientRect();
        localStorage.setItem('gsp_position', JSON.stringify({ left: rect.left, top: rect.top }));
    }

    // PointerEvents（マウス・タッチ・ペンを同じ仕組みで扱える）に統一する。
    // setPointerCaptureで、指が要素の外に出てもドラッグ中は確実にイベントを拾えるようにする。
    $handle.on('pointerdown', (e) => {
        if ($(e.target).closest('#gsp-minimize-btn, .op-btn').length) return;
        const ev = e.originalEvent || e;
        onDragStart(ev.clientX, ev.clientY);
        try { $handle[0].setPointerCapture(ev.pointerId); } catch (err) {}
        e.preventDefault();
    });
    $handle.on('pointermove', (e) => {
        if (!dragging) return;
        const ev = e.originalEvent || e;
        onDragMove(ev.clientX, ev.clientY);
    });
    $handle.on('pointerup pointercancel', () => {
        onDragEnd();
    });
})();

// ===== YouTubeリンクのクリック挙動（タブ内プレイヤー / 新しいタブ で開く、をユーザーが選べる） =====
const YT_PREF_KEY = 'yt_open_pref'; // 'ask' | 'player' | 'external'

function getYtPref() {
    return localStorage.getItem(YT_PREF_KEY) || 'ask';
}
function setYtPref(val) {
    localStorage.setItem(YT_PREF_KEY, val);
    $('#ytDefaultPref').val(val);
}

function extractYoutubeVideoId(url) {
    const m = url.match(/(?:youtube\.com\/watch\?v=|youtu\.be\/|youtube\.com\/shorts\/)([a-zA-Z0-9_-]{6,})/);
    return m ? m[1] : null;
}

let pendingYoutubeUrl = null;

// リンクカードのクリック本体。falseを返すとaタグのデフォルト遷移(新規タブ等)をキャンセルできる。
window.handleYoutubeLinkClick = (event, url) => {
    const pref = getYtPref();

    if (pref === 'external') {
        window.open(url, '_blank', 'noopener,noreferrer');
        event.preventDefault();
        return false;
    }
    if (pref === 'player') {
        playYoutubeInGlobalPlayer(url);
        event.preventDefault();
        return false;
    }

    // 初回・未設定時は毎回聞く
    pendingYoutubeUrl = url;
    $('#yt-ask-modal').removeClass('hidden');
    event.preventDefault();
    return false;
};

window.resolveYoutubeAsk = (choice) => {
    const url = pendingYoutubeUrl;
    pendingYoutubeUrl = null;
    $('#yt-ask-modal').addClass('hidden');
    if (!url) return;

    if ($('#yt-ask-remember').prop('checked')) {
        setYtPref(choice);
    }

    if (choice === 'player') {
        playYoutubeInGlobalPlayer(url);
    } else {
        window.open(url, '_blank', 'noopener,noreferrer');
    }
};

function playYoutubeInGlobalPlayer(url) {
    const videoId = extractYoutubeVideoId(url);
    if (!videoId) { window.open(url, '_blank', 'noopener,noreferrer'); return; }

    $('#gyp-embed-container').html(
        `<iframe width="100%" height="100%" src="https://www.youtube.com/embed/${videoId}?autoplay=1" title="YouTube video player" frameborder="0" allow="accelerometer; autoplay; clipboard-write; encrypted-media; gyroscope; picture-in-picture" allowfullscreen></iframe>`
    );
    $('#gyp-open-link').attr('href', url);
    $('#global-youtube-player').removeClass('hidden');

    // 読み込めたらタイトルをoEmbedから取ってくる（失敗しても再生自体には影響しない）
    $('#gyp-title').text('読み込み中...');
    fetchYoutubeOembed(url).then(data => {
        $('#gyp-title').text((data && data.title) || 'YouTube');
    }).catch(() => {
        $('#gyp-title').text('YouTube');
    });
}

window.closeGlobalYoutubePlayer = () => {
    $('#gyp-embed-container').empty(); // iframeごと消すことで再生も止まる
    $('#global-youtube-player').addClass('hidden');
};

// ===== 常設YouTubeプレイヤーの位置移動・最小化（Spotifyプレイヤーと同じ仕組み） =====
(function() {
    const $player = $('#global-youtube-player');
    const $handle = $('#gyp-drag-handle');

    const savedPos = JSON.parse(localStorage.getItem('gyp_position') || 'null');
    if (savedPos) {
        $player.css({ left: savedPos.left + 'px', top: savedPos.top + 'px', right: 'auto', bottom: 'auto' });
    }
    if (localStorage.getItem('gyp_minimized') === 'true') {
        $player.addClass('minimized');
    }

    $('#gyp-minimize-btn').on('click', (e) => {
        e.stopPropagation();
        const isMin = $player.toggleClass('minimized').hasClass('minimized');
        localStorage.setItem('gyp_minimized', isMin);
    });

    let dragging = false;
    let offsetX = 0, offsetY = 0;

    function onDragStart(clientX, clientY) {
        dragging = true;
        const rect = $player[0].getBoundingClientRect();
        offsetX = clientX - rect.left;
        offsetY = clientY - rect.top;
        $player.addClass('dragging');
    }
    function onDragMove(clientX, clientY) {
        if (!dragging) return;
        const rect = $player[0].getBoundingClientRect();
        let left = clientX - offsetX;
        let top = clientY - offsetY;
        left = Math.max(4, Math.min(window.innerWidth - rect.width - 4, left));
        top = Math.max(4, Math.min(window.innerHeight - 40, top));
        $player.css({ left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' });
    }
    function onDragEnd() {
        if (!dragging) return;
        dragging = false;
        $player.removeClass('dragging');
        const rect = $player[0].getBoundingClientRect();
        localStorage.setItem('gyp_position', JSON.stringify({ left: rect.left, top: rect.top }));
    }

    $handle.on('pointerdown', (e) => {
        if ($(e.target).closest('#gyp-minimize-btn, .op-btn').length) return;
        const ev = e.originalEvent || e;
        onDragStart(ev.clientX, ev.clientY);
        try { $handle[0].setPointerCapture(ev.pointerId); } catch (err) {}
        e.preventDefault();
    });
    $handle.on('pointermove', (e) => {
        if (!dragging) return;
        const ev = e.originalEvent || e;
        onDragMove(ev.clientX, ev.clientY);
    });
    $handle.on('pointerup pointercancel', () => { onDragEnd(); });
})();

async function fetchGithubRepoPreview(url) {
    const match = url.match(GITHUB_REPO_REGEX);
    if (!match) throw new Error('not a github repo url');
    const owner = match[2];
    const repo = match[3].replace(/\.git$/, '');
    const res = await fetch(`https://api.github.com/repos/${owner}/${repo}`);
    if (!res.ok) throw new Error('github api failed: ' + res.status);
    const json = await res.json();
    return {
        title: json.full_name || `${owner}/${repo}`,
        description: json.description || (json.stargazers_count != null ? `⭐ ${json.stargazers_count}` : null),
        image: (json.owner && json.owner.avatar_url) || null,
        siteName: 'GitHub',
    };
}

async function fetchYoutubeOembed(url) {
    const res = await fetch(`https://www.youtube.com/oembed?url=${encodeURIComponent(url)}&format=json`);
    if (!res.ok) throw new Error('youtube oembed failed: ' + res.status);
    const json = await res.json();
    return {
        title: json.title || null,
        description: json.author_name ? `${json.author_name}` : null,
        image: json.thumbnail_url || null,
        siteName: 'YouTube',
    };
}

// microlinkでURLをunfurlして、こちらの共通フォーマットに変換する
async function fetchMicrolinkPreview(url) {
    const res = await fetch(`${LINK_PREVIEW_API_URL}?url=${encodeURIComponent(url)}`);
    if (!res.ok) {
        let bodyText = '';
        try { bodyText = await res.text(); } catch (e) {}
        throw new Error('failed to fetch preview');
    }
    const json = await res.json();
    if (json.status !== 'success') {
        throw new Error('preview fetch not successful');
    }
    // status:successでもdataがnull/空のことがある（処理中など）。
    // その場合はエラーにせず「情報が薄い結果」として扱い、呼び出し側の再取得ロジックに委ねる
    const d2 = json.data || {};
    return {
        title: d2.title || null,
        description: d2.description || null,
        image: (d2.image && d2.image.url) || (d2.logo && d2.logo.url) || null,
        siteName: d2.publisher || null,
    };
}

async function fetchPreviewData(url) {
    if (YOUTUBE_URL_REGEX.test(url)) {
        try {
            return await fetchYoutubeOembed(url);
        } catch (e) {
        }
    }
    if (GITHUB_REPO_REGEX.test(url)) {
        try {
            return await fetchGithubRepoPreview(url);
        } catch (e) {
        }
    }
    return await fetchMicrolinkPreview(url);
}
const linkPreviewCache = {}; // url -> {title, description, image, siteName}
const URL_REGEX = /(https?:\/\/[^\s<>"']+)/gi;

function extractFirstUrl(text) {
    if (!text) return null;
    const m = text.match(URL_REGEX);
    if (!m) return null;
    return m[0].replace(/[),.;!?]+$/, '');
}

// 本文中のURLをクリック可能なリンクにする（safeText は既にHTMLエスケープ済みの前提）
function linkifyText(escapedText) {
    return escapedText.replace(URL_REGEX, (url) => {
        const cleanUrl = url.replace(/[),.;!?]+$/, '');
        const trail = url.slice(cleanUrl.length);

        // 下に出るリンクプレビューカードだけでなく、本文中のリンク文字列自体からも
        // YouTubeなら確認モーダル/インタブ再生を挟めるようにする（挙動を一致させる）
        if (YOUTUBE_URL_REGEX.test(cleanUrl)) {
            const safeUrlAttr = cleanUrl.replace(/'/g, "&#39;");
            return `<a href="${cleanUrl}" class="msg-link" onclick="return handleYoutubeLinkClick(event, '${safeUrlAttr}')">${cleanUrl}</a>${trail}`;
        }

        return `<a href="${cleanUrl}" target="_blank" rel="noopener noreferrer" class="msg-link">${cleanUrl}</a>${trail}`;
    });
}

async function loadLinkPreview(msgId, url, isRetry = false, isDomRetry = false) {
    try {
        let data = linkPreviewCache[url];
        if (!data) {
            data = await fetchPreviewData(url);
            const hasUsefulContent = !!(data.image || data.description);
            if (hasUsefulContent) {
                linkPreviewCache[url] = data; // 十分な情報が取れた時だけキャッシュする
            } else if (!isRetry) {
                // 初回だけ情報が薄いことがある（unfurl先が裏で処理中で、少し後にリッチな情報が揃うケース）
                // ので、少し待って1回だけ再取得を試みる
                setTimeout(() => loadLinkPreview(msgId, url, true), 1500);
                return;
            } else {
            }
        } else {
        }
        // 画像や説明文など、URL自体以上の情報が取れなかった場合はカードを出さない
        // （タイトルだけだと「リンクをそのまま繰り返しているだけ」に見えてしまうため）
        if (!data || (!data.description && !data.image)) {
            return;
        }

        const el = document.getElementById(`link-preview-${msgId}`);
        if (!el) {
            // generateMessageHtmlの呼び出し時点ではまだDOMに挿入されていないことがある
            // （特にキャッシュ利用時は取得が速すぎてDOM挿入より先に実行されてしまう）ので、少し待って1回だけ再試行する
            if (!isDomRetry) {
                setTimeout(() => loadLinkPreview(msgId, url, isRetry, true), 150);
            } else {
            }
            return;
        }

        // 高さが増える前に「一番下を見ていたか」を判定しておく（挿入後だと必ずfalseになってしまうため）
        const $box = $("#messages");
        const wasAtBottom = $box.length > 0 && ($box[0].scrollHeight - $box.scrollTop() <= $box[0].clientHeight + 200);
        let hostname = '';
        try { hostname = new URL(url).hostname; } catch (e) {}

        const isYoutube = YOUTUBE_URL_REGEX.test(url);
        const safeUrlAttr = url.replace(/'/g, "&#39;");
        const cardOpenTag = isYoutube
            ? `<a href="${url}" class="link-preview-card" onclick="return handleYoutubeLinkClick(event, '${safeUrlAttr}')">`
            : `<a href="${url}" target="_blank" rel="noopener noreferrer" class="link-preview-card">`;

        el.innerHTML = `
            ${cardOpenTag}
                ${data.image ? `<img src="${escapeHTML(data.image)}" class="link-preview-img" loading="lazy" onerror="this.remove()">` : ''}
                <div class="link-preview-body">
                    ${hostname ? `<div class="link-preview-site">${escapeHTML(hostname)}</div>` : ''}
                    ${data.title ? `<div class="link-preview-title">${escapeHTML(data.title)}</div>` : ''}
                    ${data.description ? `<div class="link-preview-desc">${escapeHTML(data.description)}</div>` : ''}
                </div>
            </a>`;

        // カード分だけ高さが増えるので、元々一番下を見ていた場合は追従してスクロールする
        scrollToBottom(wasAtBottom);
    } catch (e) {
        // 取得失敗時は何も表示しない（サイレントに諦める）
        console.error('[link-preview] 取得失敗', url, e);
    }
}

// メッセージの「見た目に関わる部分」だけを軽くハッシュ化して、変化検知に使う
// （HTML属性に直接埋め込むため、特殊文字を含まない短い文字列にする）
function simpleHash(str) {
    let hash = 0;
    for (let i = 0; i < str.length; i++) {
        hash = (hash * 31 + str.charCodeAt(i)) | 0;
    }
    return (hash >>> 0).toString(36);
}

// DOM挿入・入れ替えが完全に終わった後に、渡されたメッセージ群の中でURLを含むものだけ
// リンクプレビュー取得を呼び出す（呼び出し元は各insert/replace処理が終わった直後で使う）
function triggerLinkPreviews(docsList) {
    docsList.forEach(item => {
        const d = item.data;
        if (d.stamp || !d.text) return;
        const url = extractFirstUrl(d.text);
        if (url) loadLinkPreview(item.id, url);
    });
}

function computeMsgFingerprint(d) {
    const raw = JSON.stringify({
        text: d.text || '',
        isEdited: !!d.isEdited,
        reactions: d.reactions || {},
        image: d.image || '',
        stamp: d.stamp || '',
    });
    return simpleHash(raw);
}

function generateMessageHtml(id, d, isGrouped = false) {
    const isMe = d.uid === auth.currentUser.uid;
    const isFriend = friendIds.includes(d.uid);
    const reactions = d.reactions || {};
    const userStatus = getUserOnlineStatus(d.uid);
    const isStamp = !!d.stamp;
    
    const userData = usersCache[d.uid] || {};
    const equipped = userData.equipped || {};
    
    let badgeHtml = '';
    const badgeMap = {
        'vip_badge': { msIcon: 'workspace_premium', tileColor: '#ffd700', title: 'VIP' },
        'star_badge': { msIcon: 'star', tileColor: '#ffd700', title: 'スター' },
        'crown_badge': { msIcon: 'crown', tileColor: '#ffca28', title: 'プレミアム' }
    };
    if (equipped.badge && badgeMap[equipped.badge]) {
        const badge = badgeMap[equipped.badge];
        badgeHtml = `<span class="user-badge" title="${badge.title}"><span class="sidebar-icon-tile tile-xs" style="--tile-color:${badge.tileColor};"><span class="material-symbols-outlined">${badge.msIcon}</span></span></span>`;
    }
    
    let effectClass = '';
    if (equipped.effect === 'fire_effect') effectClass = 'effect-fire';
    else if (equipped.effect === 'sparkle_effect') effectClass = 'effect-sparkle';
    else if (equipped.effect === 'lightning_effect') effectClass = 'effect-lightning';
    else if (equipped.effect === 'rainbow_effect') effectClass = 'effect-rainbow';
    else if (equipped.effect === 'shadow_effect') effectClass = 'effect-shadow';
    else if (equipped.effect === 'ice_effect') effectClass = 'effect-ice';
    else if (equipped.effect === 'toxic_effect') effectClass = 'effect-toxic';
    else if (equipped.effect === 'gold_effect') effectClass = 'effect-gold';
    
    let rHtml = '';
    const reactionOrder = ['👍','❤️','😂','😮','😢','😡','🙏','👏','🎉','🔥','✨','💯','👀','🤔','😅','😊','🥰','😎','🤩','😇','🤗','🙌','✅','❌','⭐','💪','👌','🎊','🎈','💕'];
    const sortedReactions = Object.entries(reactions).sort((a, b) => {
        const ai = reactionOrder.indexOf(a[0]);
        const bi = reactionOrder.indexOf(b[0]);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
    for (const [emoji, uids] of sortedReactions) {
        if (uids.length > 0) rHtml += `<div class="reaction-badge ${uids.includes(auth.currentUser.uid)?'active':''}" onclick="react('${id}','${emoji}',${JSON.stringify(reactions).replace(/"/g, '&quot;')})">${emoji} ${uids.length}</div>`;
    }
    const imgHtml = d.image ? `<div class="sent-img-wrap" onclick="window.open('${d.image}')"><img src="${d.image}" class="sent-img"><span class="sent-img-badge material-symbols-outlined">photo_camera</span></div>` : '';
    const stampHtml = d.stamp ? `<img src="${d.stamp}" class="stamp-display">` : '';
    const firstUrl = (!isStamp && d.text) ? extractFirstUrl(d.text) : null;
    const linkPreviewHtml = firstUrl ? `<div class="link-preview-slot" id="link-preview-${id}"></div>` : '';
    // ここではloadLinkPreviewを呼ばない。DOM挿入・入れ替えが完全に終わった後に呼び出し元から呼ぶ
    // （先に呼んでしまうと、要素が入れ替わる前の古いDOMにプレビューを差し込んでしまい、
    //   直後のreplaceWith等で空のプレビュー枠に戻ってしまうため）
    const safeName = escapeHTML(d.name || "ゲスト");
    const safeText = escapeHTML(d.text || "");
    const replyName = d.replyTo ? escapeHTML(d.replyTo.name) : "";
    const replyText = d.replyTo ? escapeHTML(d.replyTo.text) : "";

    let timeStr = '';
    let timeMs = d.createdAt?.toMillis ? d.createdAt.toMillis() : Date.now();
    if (d.createdAt) {
        const dt = d.createdAt.toDate ? d.createdAt.toDate() : new Date(d.createdAt);
        const now = new Date();
        const isToday = dt.toDateString() === now.toDateString();
        const yesterday = new Date(now); yesterday.setDate(now.getDate() - 1);
        const isYesterday = dt.toDateString() === yesterday.toDateString();
        const hm = dt.toLocaleTimeString('ja-JP', { hour: '2-digit', minute: '2-digit' });
        if (isToday) { timeStr = hm; }
        else if (isYesterday) { timeStr = '昨日 ' + hm; }
        else { timeStr = dt.toLocaleDateString('ja-JP', { month: 'numeric', day: 'numeric' }) + ' ' + hm; }
    }

    // アイコン列（リアクション追加・返信・編集・削除）は右クリック/長押しの独自メニューに統一したので、
    // メッセージ内にはリアクションバッジだけを表示する
    const msgOpsHtml = rHtml;

    return `<div class="message ${isMe?'me':''} ${isStamp?'is-stamp':''} ${isFriend?'is-friend':''} ${isGrouped?'grouped':''} ${effectClass}" id="msg-${id}" data-uid="${d.uid}" data-msgid="${id}" data-is-me="${isMe}" data-is-stamp="${isStamp}" data-time-ms="${timeMs}" data-time="${timeStr}" data-fp="${computeMsgFingerprint(d)}" data-name="${safeName.replace(/"/g,'&quot;')}" data-text="${safeText.replace(/"/g,'&quot;').replace(/\n/g,' ')}">
        <div class="icon-container" onclick="showProfile('${d.uid}')">
            <img src="${d.photo || DEFAULT_AVATAR}" class="icon">
            <div class="status-dot ${userStatus === 'online' ? 'online' : 'offline'}"></div>
        </div>
        <div class="msg-body">
            <div class="user-info">${safeName}${badgeHtml}${timeStr ? `<span class="msg-time">${timeStr}</span>` : ''}</div>
            <div class="bubble">
                ${d.replyTo ? `<div class="reply-in-bubble" onclick="scrollToMsg('${d.replyTo.id}')">@${replyName} ${replyText}</div>` : ''}
                ${d.text ? `<div>${linkifyText(safeText)}${d.isEdited ? '<span class="edited-mark">(編集済)</span>' : ''}</div>` : ''}
                ${linkPreviewHtml}
                ${imgHtml}
                ${stampHtml}
            </div>
            <div class="msg-ops">
                ${msgOpsHtml}
            </div>
        </div></div>`;
}

$("#messages").on("scroll", function() { if ($(this).scrollTop() === 0) loadMoreMessages(); });

function updateFriendReqSidebarBadge() {
    const $badge = $('#friendReqSidebarBadge');
    if (pendingFriendReqCount > 0) {
        $badge.text(pendingFriendReqCount > 9 ? '9+' : pendingFriendReqCount).removeClass('hidden');
    } else {
        $badge.addClass('hidden');
    }
}

function triggerBadge(roomId = null) {
    if(roomId) {
        unreadRooms[roomId] = (unreadRooms[roomId] || 0) + 1;
        updateDMBadges();
    }
    
    recalculateTotalUnread();
    // 通知音はここでは鳴らさない（呼び出し元でメッセージ種別に応じて鳴らす）
}

function renderMessages(snap, isDesc = false) {
    if (pauseSnapshot) {
        return;
    }
    
    const $box = $("#messages");
    
    let docs = [];
    snap.forEach(d => docs.push({id: d.id, data: d.data()}));
    if (myBlockedUsers.length > 0) {
        docs = docs.filter(item => !myBlockedUsers.includes(item.data.uid));
    }
    if(isDesc) docs.reverse();
    
    if (isInitialLoad) {
        const fragment = document.createDocumentFragment();
        const tempDiv = document.createElement('div');
        const groupedFlags = computeGroupedFlags(docs);

        docs.forEach((item, idx) => {
            tempDiv.innerHTML = generateMessageHtml(item.id, item.data, groupedFlags[idx]);
            while (tempDiv.firstChild) {
                fragment.appendChild(tempDiv.firstChild);
            }
        });
        
        $box.empty();
        $box[0].appendChild(fragment);
        
        const images = $box[0].querySelectorAll('img');
        let loadedImages = 0;
        const totalImages = images.length;
        
        const checkAllImagesLoaded = () => {
            loadedImages++;
            if (loadedImages >= totalImages && !isLoadingMoreMessages) {
                $box[0].scrollTop = $box[0].scrollHeight;
            }
        };
        
        images.forEach(img => {
            if (img.complete) {
                checkAllImagesLoaded();
            } else {
                img.addEventListener('load', checkAllImagesLoaded);
                img.addEventListener('error', checkAllImagesLoaded);
            }
        });
        
        if (!isLoadingMoreMessages) {
            $box[0].scrollTop = $box[0].scrollHeight;
            
            requestAnimationFrame(() => {
                $box[0].scrollTop = $box[0].scrollHeight;
            });
            setTimeout(() => {
                $box[0].scrollTop = $box[0].scrollHeight;
            }, 50);
            setTimeout(() => {
                $box[0].scrollTop = $box[0].scrollHeight;
            }, 100);
            setTimeout(() => {
                $box[0].scrollTop = $box[0].scrollHeight;
            }, 200);
            setTimeout(() => {
                $box[0].scrollTop = $box[0].scrollHeight;
            }, 400);
            setTimeout(() => {
                $box[0].scrollTop = $box[0].scrollHeight;
            }, 600);
        }
        isInitialLoad = false;
        lastRenderedMsgId = docs.length ? docs[docs.length - 1].id : null;
        triggerLinkPreviews(docs);
    } else {
        const updates = [];
        const additions = [];
        const groupedFlags = computeGroupedFlags(docs);
        const touchedItems = []; // 実際に作り直した（＝プレビュー再取得が必要な）メッセージだけ集める

        docs.forEach((item, idx) => {
            const existing = $(`#msg-${item.id}`);
            if (existing.length) {
                const newFp = computeMsgFingerprint(item.data);
                if (existing.attr('data-fp') === newFp) {
                    return; // 内容に変化が無いメッセージは作り直さない（プレビュー再取得や表示のガタつきを防ぐ）
                }
                updates.push({element: existing, html: generateMessageHtml(item.id, item.data, groupedFlags[idx])});
                touchedItems.push(item);
            } else {
                additions.push(generateMessageHtml(item.id, item.data, groupedFlags[idx]));
                touchedItems.push(item);
            }
        });
        
        updates.forEach(({element, html}) => element.replaceWith(html));
        
        if (additions.length > 0) {
            const fragment = document.createDocumentFragment();
            const tempDiv = document.createElement('div');
            
            additions.forEach(html => {
                tempDiv.innerHTML = html;
                while (tempDiv.firstChild) {
                    fragment.appendChild(tempDiv.firstChild);
                }
            });
            
            $box[0].appendChild(fragment);
        }

        // ここまででDOMの入れ替え・追加が完全に終わっているので、ここでプレビュー取得を呼ぶ
        triggerLinkPreviews(touchedItems);
        
        const newestDoc = docs.length ? docs[docs.length - 1] : null;
        const hasNewMessage = !isLoadingMoreMessages && newestDoc && newestDoc.id !== lastRenderedMsgId;

        if (hasNewMessage) {
            const lastDoc = newestDoc;
            const isMyMessage = auth.currentUser && lastDoc.data.uid === auth.currentUser.uid;

            if (!isLoadingMoreMessages) {
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        $box[0].scrollTop = $box[0].scrollHeight;
                    });
                });
            }
            
            if (auth.currentUser && lastDoc.data.uid !== auth.currentUser.uid) {
                
                const isAtBottom = ($box[0].scrollHeight - $box.scrollTop() <= $box[0].clientHeight + 150);
                const isHiddenOrUnfocused = document.visibilityState === 'hidden' || !document.hasFocus();
                const isUnseen = isHiddenOrUnfocused || !isAtBottom;

                const roomIdForBadge = currentRoomId || "global";
                const lastSeen = lastSeenTimestamps[roomIdForBadge] || 0;
                const msgTime = lastDoc.data.createdAt ? lastDoc.data.createdAt.toMillis() : Date.now();
                const isDmNotif = !!currentRoomId;

                if (msgTime > lastSeen) {
                    // 通知音は「見ているかどうか」に関わらず、新着メッセージなら鳴らす
                    playNotifSound(isDmNotif ? 'soundDm' : 'soundChat');
                }

                if (isUnseen) {
                    if(msgTime > lastSeen) {
                        triggerBadge(roomIdForBadge);
                        
                        if (isHiddenOrUnfocused) {
                            const notifTitle = `新着: ${lastDoc.data.name || "ゲスト"}`;
                            const notifBody = lastDoc.data.text || (lastDoc.data.stamp ? "スタンプ" : "画像");
                            sendPushNotif(isDmNotif ? 'pushDm' : 'pushChat', notifTitle, notifBody, lastDoc.data.photo || DEFAULT_AVATAR, 'chat-msg');
                        }
                    }
                } else {
                    clearUnread();
                }
            }
        }
        if (newestDoc && !isLoadingMoreMessages) {
            lastRenderedMsgId = newestDoc.id;
        }
    }
}

let isSending = false;

// ===== 連投・コピペ荒らし対策（クライアント側の簡易フラッド防止） =====
const MSG_RATE_WINDOW_MS = 3000;   // この時間内に
const MSG_RATE_MAX_COUNT = 5;      // これ以上送るとクールダウン
const MSG_RATE_COOLDOWN_MS = 8000; // クールダウン時間
const MSG_DUP_WINDOW_MS = 10000;   // 同じ内容の連投を弾く時間

let recentMessageTimestamps = [];
let msgRateCooldownUntil = 0;
let lastSentMessageText = '';
let lastSentMessageAt = 0;

function checkMessageRateLimit() {
    const now = Date.now();
    const txt = $("#messageInput").val().trim();

    if (now < msgRateCooldownUntil) {
        const remain = Math.ceil((msgRateCooldownUntil - now) / 1000);
        alert(`⏳ 連続送信が多すぎます。あと${remain}秒待ってください`);
        return false;
    }

    if (txt && txt === lastSentMessageText && (now - lastSentMessageAt) < MSG_DUP_WINDOW_MS) {
        alert('⚠️ 同じ内容の連続投稿はできません');
        return false;
    }

    recentMessageTimestamps = recentMessageTimestamps.filter(t => now - t < MSG_RATE_WINDOW_MS);
    recentMessageTimestamps.push(now);
    if (recentMessageTimestamps.length > MSG_RATE_MAX_COUNT) {
        msgRateCooldownUntil = now + MSG_RATE_COOLDOWN_MS;
        alert(`⏳ 送信ペースが速すぎます。${MSG_RATE_COOLDOWN_MS / 1000}秒待ってから送信してください`);
        return false;
    }

    lastSentMessageText = txt;
    lastSentMessageAt = now;
    return true;
}

const send = async () => {
    if (isSending) return;
    if (window.__isBanned) { alert('🚫 このアカウントは利用停止中のため送信できません'); return; }
    if (!checkMessageRateLimit()) return;
    
    const txt = $("#messageInput").val().trim(); 
    if (!txt && !pendingImageUrl) return;
    
    isSending = true;
    $("#sendBtn").css("opacity", "0.5").css("pointer-events", "none");
    
    try {
        const colRef = currentRoomId ? collection(db, "rooms", currentRoomId, "messages") : collection(db, "chats");
        if(editTargetId) {
            await updateDoc(doc(colRef, editTargetId), { text: txt, isEdited: true });
            cancelEdit();
        } else {
            await addDoc(colRef, { text: txt, image: pendingImageUrl, uid: auth.currentUser.uid, name: auth.currentUser.displayName || "ゲスト", photo: auth.currentUser.photoURL || DEFAULT_AVATAR, createdAt: serverTimestamp(), replyTo: replyTarget, reactions: {} });
            
            if (currentRoomId) {
                await updateDoc(doc(db, "rooms", currentRoomId), { lastMessage: txt || "画像", updatedAt: serverTimestamp(), updatedBy: auth.currentUser.uid });
            }

            scrollToBottom(true);
        }
        $("#messageInput").val("").css("height", "auto"); 
        pendingImageUrl = null; 
        replyTarget = null; 
        $("#upload-preview-container, #reply-preview").addClass("hidden");
        updateTypingStatus(false);
    } catch (error) {
        console.error("Send error:", error);
        alert("メッセージの送信に失敗しました");
    } finally {
        setTimeout(() => {
            isSending = false;
            $("#sendBtn").css("opacity", "1").css("pointer-events", "auto");
        }, 500);
    }
};

let isCurrentlyTyping = false;

const updateTypingStatus = async (isTyping) => {
    if(!auth.currentUser) return;
    if (isCurrentlyTyping !== isTyping) {
        isCurrentlyTyping = isTyping;
        await updateDoc(doc(db, "users", auth.currentUser.uid), { isTyping: isTyping });
    }
};

$("#messageInput").on("input", function() {
    if (!isCurrentlyTyping) {
        updateTypingStatus(true);
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => updateTypingStatus(false), 3000);
});

window.sendStamp = async (url) => {
    const colRef = currentRoomId ? collection(db, "rooms", currentRoomId, "messages") : collection(db, "chats");
    await addDoc(colRef, { stamp: url, uid: auth.currentUser.uid, name: auth.currentUser.displayName || "ゲスト", photo: auth.currentUser.photoURL || DEFAULT_AVATAR, createdAt: serverTimestamp(), replyTo: replyTarget, reactions: {} });
    
    if (currentRoomId) {
        await updateDoc(doc(db, "rooms", currentRoomId), { lastMessage: "スタンプ", updatedAt: serverTimestamp(), updatedBy: auth.currentUser.uid });
    }

    replyTarget = null; $("#reply-preview").addClass("hidden"); $("#stamp-modal").addClass("hidden");
    scrollToBottom(true);
};

let stampPickerGroups = []; // [{ key, label, thumb, stamps: [{url,name}] }]
let stampPickerActiveKey = 'free';

const initStampPicker = async () => {
    const groups = [{
        key: 'free',
        label: '無料',
        thumb: FREE_STAMP_LIST[0],
        stamps: FREE_STAMP_LIST.map(url => ({ url, name: '' }))
    }];

    // 購入済みのスタンプパック（公式＋自作）があれば、パックごとに1タブとして追加する
    try {
        if (auth.currentUser) {
            const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
            const ownedPacks = (userDoc.exists() ? userDoc.data().ownedPacks : []) || [];
            if (ownedPacks.length > 0) {
                const officialOwned = STAMP_PACKS.filter(p => ownedPacks.includes(p.id));
                const customIds = ownedPacks.filter(id => !STAMP_PACKS.some(p => p.id === id));
                const customPacks = (await Promise.all(customIds.map(async id => {
                    try {
                        const snap = await getDoc(doc(db, "stampPacks", id));
                        return snap.exists() ? { id: snap.id, ...snap.data() } : null;
                    } catch { return null; }
                }))).filter(Boolean);

                [...officialOwned, ...customPacks].forEach(pack => {
                    if (!pack.stamps || pack.stamps.length === 0) return;
                    groups.push({
                        key: pack.id,
                        label: pack.name,
                        thumb: pack.thumbnail || pack.stamps[0].url,
                        stamps: pack.stamps
                    });
                });
            }
        }
    } catch (error) {
        console.error('Load owned stamp packs error:', error);
    }

    stampPickerGroups = groups;
    if (!groups.some(g => g.key === stampPickerActiveKey)) {
        stampPickerActiveKey = 'free';
    }

    const $tabs = $('#stamp-pack-tabs').empty();
    groups.forEach(g => {
        $tabs.append(`
            <div class="stamp-pack-tab ${g.key === stampPickerActiveKey ? 'active' : ''}" data-key="${g.key}" title="${g.label}" onclick="switchStampPickerTab('${g.key}')">
                <img src="${g.thumb}" alt="${g.label}">
            </div>
        `);
    });

    renderStampPickerGrid();
};

function renderStampPickerGrid() {
    const group = stampPickerGroups.find(g => g.key === stampPickerActiveKey) || stampPickerGroups[0];
    const $list = $("#stamp-list").empty();
    if (!group) return;
    group.stamps.forEach(s => {
        $list.append(`<img src="${s.url}" class="stamp-item" title="${s.name || ''}" onclick="sendStamp('${s.url}')">`);
    });
}

window.switchStampPickerTab = (key) => {
    stampPickerActiveKey = key;
    $('#stamp-pack-tabs .stamp-pack-tab').removeClass('active');
    $(`#stamp-pack-tabs .stamp-pack-tab[data-key="${key}"]`).addClass('active');
    renderStampPickerGrid();
};

// ========== アイテム効果適用 ==========

async function applyUserTheme() {
    try {
        const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
        const userData = userDoc.data();
        const equipped = userData.equipped || {};
        
        $('body').removeClass('rainbow-theme heart-theme');
        
        if (equipped.theme === 'rainbow_theme') {
            $('body').addClass('rainbow-theme');
        } else if (equipped.theme === 'heart_theme') {
            $('body').addClass('heart-theme');
        }
    } catch (error) {
        console.error('Theme application error:', error);
    }
}

// ========== ショップシステム ==========

const shopItems = [
    { id: 'vip_badge', name: 'VIPバッジ', icon: '👑', msIcon: 'workspace_premium', tileColor: '#ffd700', price: 300, description: '名前の横にVIPバッジが表示されます', category: 'badge' },
    { id: 'rainbow_theme', name: 'レインボーテーマ', icon: '🌈', msIcon: 'palette', tileColor: '#ff8fd8', price: 250, description: 'チャット背景が虹色に', category: 'theme' },
    { id: 'fire_effect', name: '炎エフェクト', icon: '🔥', msIcon: 'local_fire_department', tileColor: '#ff6b35', price: 200, description: 'メッセージに炎エフェクト', category: 'effect' },
    { id: 'star_badge', name: 'スターバッジ', icon: '⭐', msIcon: 'star', tileColor: '#ffd700', price: 150, description: '名前の横にスターが表示', category: 'badge' },
    { id: 'heart_theme', name: 'ハートテーマ', icon: '💕', msIcon: 'favorite', tileColor: '#ff6b9d', price: 180, description: 'ピンク色のテーマ', category: 'theme' },
    { id: 'sparkle_effect', name: 'キラキラエフェクト', icon: '✨', msIcon: 'auto_awesome', tileColor: '#f093fb', price: 220, description: 'メッセージがキラキラ', category: 'effect' },
    { id: 'crown_badge', name: 'クラウンバッジ', icon: '👸', msIcon: 'crown', tileColor: '#ffca28', price: 350, description: 'プレミアムクラウン', category: 'badge' },
    { id: 'lightning_effect', name: '稲妻エフェクト', icon: '⚡', msIcon: 'bolt', tileColor: '#ffeb3b', price: 280, description: 'メッセージに稲妻', category: 'effect' },
    { id: 'rainbow_effect', name: '虹色エフェクト', icon: '🌟', msIcon: 'auto_awesome', tileColor: '#a78bfa', price: 300, description: '虹色に輝くオーラ', category: 'effect' },
    { id: 'shadow_effect', name: 'シャドウエフェクト', icon: '🌑', msIcon: 'dark_mode', tileColor: '#7c7c8a', price: 250, description: '暗黒のオーラ', category: 'effect' },
    { id: 'ice_effect', name: '氷エフェクト', icon: '❄️', msIcon: 'ac_unit', tileColor: '#4fc3f7', price: 260, description: '氷の結晶エフェクト', category: 'effect' },
    { id: 'toxic_effect', name: '毒エフェクト', icon: '☠️', msIcon: 'science', tileColor: '#a78bfa', price: 270, description: '紫色の毒々しいオーラ', category: 'effect' },
    { id: 'gold_effect', name: 'ゴールドエフェクト', icon: '💛', msIcon: 'diamond', tileColor: '#ffd700', price: 400, description: '金色に輝く豪華なオーラ', category: 'effect' }
];

const SHOP_CATEGORIES = [
    { id: 'badge', label: '🏅 バッジ' },
    { id: 'theme', label: '🎨 テーマ' },
    { id: 'effect', label: '✨ エフェクト' },
    { id: 'stamp', label: '🎫 スタンプ' },
];
let shopActiveCategory = 'badge';

async function checkLoginBonus() {
    try {
        const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
        if (!userDoc.exists()) {
            return true;
        }
        
        const userData = userDoc.data();
        const lastLogin = userData.lastLogin;
        
        if (!lastLogin) {
            return true;
        }
        
        const lastLoginDate = lastLogin.toDate();
        const now = new Date();
        
        const lastLoginDay = new Date(lastLoginDate.getFullYear(), lastLoginDate.getMonth(), lastLoginDate.getDate());
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        
        const canClaim = lastLoginDay.getTime() < today.getTime();
        
        return canClaim;
        
    } catch (error) {
        console.error('Check login bonus error:', error);
        return false;
    }
}

const DAILY_BONUS_CHIPS = 30;

async function claimLoginBonus() {
    try {
        const canClaim = await checkLoginBonus();
        if (!canClaim) {
            return { success: false, message: '今日のボーナスは既に受け取り済みです' };
        }
        
        const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
        const userData = userDoc.data();
        const currentChips = userData.chips || 0;
        
        await setDoc(doc(db, "users", auth.currentUser.uid), {
            chips: currentChips + DAILY_BONUS_CHIPS,
            lastLogin: serverTimestamp()
        }, { merge: true });
        
        return { success: true, message: `+${DAILY_BONUS_CHIPS}チップ獲得！`, chips: currentChips + DAILY_BONUS_CHIPS, bonus: DAILY_BONUS_CHIPS };
        
    } catch (error) {
        console.error('Claim login bonus error:', error);
        return { success: false, message: 'エラーが発生しました: ' + error.message };
    }
}

async function openLoginBonusModal() {
    $('#login-bonus-modal').removeClass('hidden');
    
    const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
    const userData = userDoc.data();
    const currentChips = userData.chips || 0;
    $('#bonus-amount').text('+' + DAILY_BONUS_CHIPS);
    $('#bonus-current-coins').text(currentChips.toLocaleString());
    
    const canClaim = await checkLoginBonus();
    
    if (canClaim) {
        $('#bonus-claim-section').removeClass('hidden');
        $('#bonus-already-claimed').addClass('hidden');
    } else {
        $('#bonus-claim-section').addClass('hidden');
        $('#bonus-already-claimed').removeClass('hidden');
    }
}


// ========== ポーカー ==========
const POKER_SUITS = ['♠', '♥', '♦', '♣'];
const POKER_RANKS = ['2','3','4','5','6','7','8','9','10','J','Q','K','A'];
const POKER_PAYOUTS = {
    'ロイヤルフラッシュ': 250,
    'ストレートフラッシュ': 50,
    'フォーカード':        25,
    'フルハウス':          9,
    'フラッシュ':          6,
    'ストレート':          4,
    'スリーカード':        3,
    'ツーペア':            2,
    'ワンペア':            1,
    'ハズレ':              0,
};

let pokerDeck = [];
let pokerHand = [];
let pokerHeld = [false, false, false, false, false];
let pokerBet = 100;
let pokerPhase = 'bet';
let pokerCurrentWin = 0;
let pokerDoubleUpWin = 0;

function pokerMakeDeck() {
    const deck = [];
    for (const s of POKER_SUITS) {
        for (const r of POKER_RANKS) {
            deck.push({ suit: s, rank: r });
        }
    }
    for (let i = deck.length - 1; i > 0; i--) {
        const j = Math.floor(Math.random() * (i + 1));
        [deck[i], deck[j]] = [deck[j], deck[i]];
    }
    return deck;
}

function pokerCardHtml(card, idx, clickable) {
    const isRed = card.suit === '♥' || card.suit === '♦';
    const held = pokerHeld[idx];
    return `<div class="poker-card ${isRed ? 'red' : 'black'} ${held ? 'held' : ''}" 
        ${clickable ? `onclick="pokerToggleHold(${idx})"` : ''}
        id="poker-card-${idx}">
        <div class="poker-card-rank">${card.rank}</div>
        <div class="poker-card-suit">${card.suit}</div>
    </div>`;
}

function pokerRenderCards(clickable) {
    $('#poker-cards').html(pokerHand.map((c, i) => pokerCardHtml(c, i, clickable)).join(''));
    if (clickable) {
        $('#poker-hold-btns').html(pokerHand.map((c, i) =>
            `<button class="poker-hold-btn ${pokerHeld[i] ? 'held' : ''}" onclick="pokerToggleHold(${i})">
                ${pokerHeld[i] ? 'HOLD ✓' : 'HOLD'}
            </button>`
        ).join(''));
    } else {
        $('#poker-hold-btns').html('');
    }
}

window.pokerToggleHold = (idx) => {
    if (pokerPhase !== 'draw') return;
    pokerHeld[idx] = !pokerHeld[idx];
    pokerRenderCards(true);
};

function pokerRankValue(rank) {
    return POKER_RANKS.indexOf(rank);
}

function pokerEvaluate(hand) {
    const ranks = hand.map(c => pokerRankValue(c.rank));
    const suits = hand.map(c => c.suit);
    const rankCounts = {};
    ranks.forEach(r => rankCounts[r] = (rankCounts[r] || 0) + 1);
    const counts = Object.values(rankCounts).sort((a,b) => b - a);
    const isFlush = suits.every(s => s === suits[0]);
    const sortedRanks = [...ranks].sort((a,b) => a - b);
    const isStr = (sortedRanks[4] - sortedRanks[0] === 4 && new Set(sortedRanks).size === 5);
    const isWheel = JSON.stringify(sortedRanks) === JSON.stringify([0,1,2,3,12]);
    const isStraight = isStr || isWheel;
    const isRoyal = isFlush && JSON.stringify(sortedRanks) === JSON.stringify([8,9,10,11,12]);

    if (isRoyal)                          return 'ロイヤルフラッシュ';
    if (isFlush && isStraight)            return 'ストレートフラッシュ';
    if (counts[0] === 4)                  return 'フォーカード';
    if (counts[0] === 3 && counts[1] === 2) return 'フルハウス';
    if (isFlush)                          return 'フラッシュ';
    if (isStraight)                       return 'ストレート';
    if (counts[0] === 3)                  return 'スリーカード';
    if (counts[0] === 2 && counts[1] === 2) return 'ツーペア';
    if (counts[0] === 2) {
        const pairRank = parseInt(Object.keys(rankCounts).find(k => rankCounts[k] === 2));
        if (pairRank >= 9) return 'ワンペア';
    }
    return 'ハズレ';
}

function pokerInit(coins) {
    pokerPhase = 'bet';
    pokerHeld = [false,false,false,false,false];
    pokerHand = [];
    pokerCurrentWin = 0;
    pokerDoubleUpWin = 0;
    $('#poker-coins').text(String(coins).padStart(4, '0'));
    $('#poker-cards').html('');
    $('#poker-hold-btns').html('');
    $('#poker-hand-name').text('');
    $('#poker-result').addClass('hidden');
    $('#poker-doubleup-area').addClass('hidden');
    $('#poker-deal-btn').removeClass('hidden');
    $('#poker-draw-btn').addClass('hidden');
    $('#poker-bet-area').show();
}

$('.poker-bet-btn').on('click', function() {
    if (pokerPhase !== 'bet') return;
    $('.poker-bet-btn').removeClass('active');
    $(this).addClass('active');
    pokerBet = parseInt($(this).data('bet'));
});

$('#poker-deal-btn').on('click', async () => {
    if (pokerPhase !== 'bet') return;
    const userRef = doc(db, "users", auth.currentUser.uid);
    const userSnap = await getDoc(userRef);
    const coins = userSnap.data().coins || 0;
    if (coins < pokerBet) { alert(`💰 コインが足りません（必要: ${pokerBet.toLocaleString()}）`); return; }

    await updateDoc(userRef, { coins: coins - pokerBet });
    $('#poker-coins').text(String(coins - pokerBet).padStart(4, '0'));

    pokerDeck = pokerMakeDeck();
    pokerHand = pokerDeck.splice(0, 5);
    pokerHeld = [false,false,false,false,false];
    pokerPhase = 'draw';

    const handName = pokerEvaluate(pokerHand);
    $('#poker-hand-name').text(handName !== 'ハズレ' ? handName : '');
    pokerRenderCards(true);
    $('#poker-deal-btn').addClass('hidden');
    $('#poker-draw-btn').removeClass('hidden');
    $('#poker-result').addClass('hidden');
    $('#poker-doubleup-area').addClass('hidden');
    $('#poker-bet-area').hide();
});

$('#poker-draw-btn').on('click', async () => {
    if (pokerPhase !== 'draw') return;
    pokerPhase = 'result';

    for (let i = 0; i < 5; i++) {
        if (!pokerHeld[i]) pokerHand[i] = pokerDeck.shift();
    }
    pokerHeld = [false,false,false,false,false];
    pokerRenderCards(false);

    const handName = pokerEvaluate(pokerHand);
    const mult = POKER_PAYOUTS[handName] || 0;
    pokerCurrentWin = pokerBet * mult;
    pokerDoubleUpWin = pokerCurrentWin;

    $('#poker-hand-name').text(handName);
    $('#poker-draw-btn').addClass('hidden');

    $('#poker-result').removeClass('hidden');
    if (pokerCurrentWin > 0) {
        $('#poker-result-text').html(`<span style="color:#ffd700;">🎉 ${handName}！ +${pokerCurrentWin.toLocaleString()} コイン</span>`);
        $('#poker-doubleup-btn').removeClass('hidden');
    } else {
        $('#poker-result-text').html(`<span style="color:#ff4757;">😢 ハズレ...</span>`);
        $('#poker-doubleup-btn').addClass('hidden');
    }

    if (pokerCurrentWin > 0) {
        const userRef = doc(db, "users", auth.currentUser.uid);
        const userSnap = await getDoc(userRef);
        const coins = userSnap.data().coins || 0;
        await updateDoc(userRef, { coins: coins + pokerCurrentWin });
        $('#poker-coins').text(String(coins + pokerCurrentWin).padStart(4, '0'));
    }
});

$('#poker-collect-btn').on('click', () => {
    pokerPhase = 'bet';
    pokerHeld = [false,false,false,false,false];
    $('#poker-result').addClass('hidden');
    $('#poker-doubleup-area').addClass('hidden');
    $('#poker-deal-btn').removeClass('hidden');
    $('#poker-draw-btn').addClass('hidden');
    $('#poker-hand-name').text('');
    $('#poker-cards').html('');
    $('#poker-hold-btns').html('');
    $('#poker-bet-area').show();
});

$('#poker-doubleup-btn').on('click', () => {
    if (pokerPhase !== 'result') return;
    pokerPhase = 'doubleup';
    $('#poker-result').addClass('hidden');
    $('#poker-doubleup-area').removeClass('hidden');
    $('#poker-du-result').text('');
    $('#poker-du-after-btns').addClass('hidden');
    $('#poker-du-btns').show();

    const duDeck = pokerMakeDeck();
    const dealerCard = duDeck.shift();
    window._pokerDuDeck = duDeck;
    window._pokerDuDealerCard = dealerCard;

    $('#poker-doubleup-win').text(`現在の獲得: ${pokerDoubleUpWin.toLocaleString()} コイン → 当たれば ${(pokerDoubleUpWin * 2).toLocaleString()} コイン`);

    $('#poker-du-cards').html(`
        <div class="poker-card black" style="background:linear-gradient(135deg,#1a1a2e,#16213e); border:2px solid #ffd700;">
            <div style="font-size:28px;">🂠</div>
        </div>
    `);
});

window.pokerDoubleUpChoice = async (choice) => {
    if (pokerPhase !== 'doubleup') return;
    $('#poker-du-btns').hide();

    const dealerCard = window._pokerDuDealerCard;
    const dealerRank = pokerRankValue(dealerCard.rank);
    const isRed = dealerCard.suit === '♥' || dealerCard.suit === '♦';

    $('#poker-du-cards').html(`
        <div class="poker-card ${isRed ? 'red' : 'black'}">
            <div class="poker-card-rank">${dealerCard.rank}</div>
            <div class="poker-card-suit">${dealerCard.suit}</div>
        </div>
    `);

    const win = (choice === 'high' && dealerRank >= 6) || (choice === 'low' && dealerRank <= 4);
    const push = dealerRank === 5;

    if (win) {
        pokerDoubleUpWin *= 2;
        $('#poker-du-result').html(`<span style="color:#00c853;">✅ 当たり！ ${pokerDoubleUpWin.toLocaleString()} コイン</span>`);
        const userRef = doc(db, "users", auth.currentUser.uid);
        const userSnap = await getDoc(userRef);
        const coins = userSnap.data().coins || 0;
        const bonus = pokerDoubleUpWin / 2;
        await updateDoc(userRef, { coins: coins + bonus });
        $('#poker-coins').text(String(coins + bonus).padStart(4, '0'));
        pokerPhase = 'doubleup';
        $('#poker-doubleup-win').text(`現在の獲得: ${pokerDoubleUpWin.toLocaleString()} コイン → 当たれば ${(pokerDoubleUpWin * 2).toLocaleString()} コイン`);
        $('#poker-du-after-btns').removeClass('hidden');
        $('#poker-du-again-btn').show();
        $('#poker-du-collect-btn').show();
    } else {
        const userRef = doc(db, "users", auth.currentUser.uid);
        const userSnap = await getDoc(userRef);
        const coins = userSnap.data().coins || 0;
        await updateDoc(userRef, { coins: Math.max(0, coins - pokerDoubleUpWin) });
        $('#poker-coins').text(String(Math.max(0, coins - pokerDoubleUpWin)).padStart(4, '0'));
        pokerDoubleUpWin = 0;
        $('#poker-du-result').html(`<span style="color:#ff4757;">${push ? '😐 7はドロー（負け）' : '❌ ハズレ...全部没収'}</span>`);
        $('#poker-du-after-btns').removeClass('hidden');
        $('#poker-du-again-btn').hide();
        $('#poker-du-collect-btn').show();
    }
};

$('#poker-du-again-btn').on('click', () => {
    pokerPhase = 'doubleup';
    $('#poker-du-result').text('');
    $('#poker-du-after-btns').addClass('hidden');
    $('#poker-du-btns').show();
    const duDeck = pokerMakeDeck();
    const dealerCard = duDeck.shift();
    window._pokerDuDeck = duDeck;
    window._pokerDuDealerCard = dealerCard;
    $('#poker-doubleup-win').text(`現在の獲得: ${pokerDoubleUpWin.toLocaleString()} コイン → 当たれば ${(pokerDoubleUpWin * 2).toLocaleString()} コイン`);
    $('#poker-du-cards').html(`
        <div class="poker-card black" style="background:linear-gradient(135deg,#1a1a2e,#16213e); border:2px solid #ffd700;">
            <div style="font-size:28px;">🂠</div>
        </div>
    `);
});

$('#poker-du-collect-btn').on('click', () => {
    pokerPhase = 'bet';
    $('#poker-doubleup-area').addClass('hidden');
    $('#poker-deal-btn').removeClass('hidden');
    $('#poker-hand-name').text('');
    $('#poker-cards').html('');
    $('#poker-hold-btns').html('');
    $('#poker-bet-area').show();
});

// ========== スロットマシン ==========
const slotSymbols = ['🍒', '🍋', '🍊', '🍇', '⭐', '💎', '🎁'];
const slotPayouts = {
    '🍒': 5,
    '🍋': 8,
    '🍊': 12,
    '🍇': 20,
    '⭐': 40,
    '💎': 100,
    '🎁': 0
};
let isSpinning = false;
let hasSpecialSpin = false;
let boostedSpinsRemaining = 0;
let currentBet = 1;

$('.bet-btn').on('click', function() {
    if (isSpinning) return;
    
    const newBet = parseInt($(this).data('bet'));
    
    if (boostedSpinsRemaining > 0 && newBet !== currentBet) {
        if (!confirm(`🔥 強化スピン中です！\n\nベットを変更すると強化スピンが消えますがよろしいですか？\n\n残り: ${boostedSpinsRemaining}回`)) {
            return;
        }
        boostedSpinsRemaining = 0;
        updateBoostedSpinsDisplay();
    }
    
    $('.bet-btn').removeClass('active').css('border-color', '#666');
    $(this).addClass('active');
    currentBet = newBet;
    
    const cost = 10 * currentBet;
    $('#spin-btn-cost').text(`- ${cost} COINS -`);
    $('#bet-multiplier-text').text(`(×${currentBet})`);
    
    updatePayTable();
});

function updatePayTable() {
    const payouts = {
        '🍒': 5 * currentBet,
        '🍋': 8 * currentBet,
        '🍊': 12 * currentBet,
        '🍇': 20 * currentBet,
        '⭐': 40 * currentBet,
        '💎': 100 * currentBet
    };
    
    $('#pay-table').html(`
        🍒🍒🍒 → ×${5 * currentBet}  (${payouts['🍒'] * 10})<br>
        🍋🍋🍋 → ×${8 * currentBet}  (${payouts['🍋'] * 10})<br>
        🍊🍊🍊 → ×${12 * currentBet}  (${payouts['🍊'] * 10})<br>
        🍇🍇🍇 → ×${20 * currentBet}  (${payouts['🍇'] * 10})<br>
        ⭐⭐⭐ → ×${40 * currentBet}  (${payouts['⭐'] * 10})<br>
        💎💎💎 → ×${100 * currentBet}  (${payouts['💎'] * 10}) + SPECIAL!<br>
        🎁🎁🎁 → 🔥 BOOST x10 SPINS!
    `);
}

function initReelStrips() {
    for (let i = 1; i <= 3; i++) {
        const strip = $(`#strip${i}`);
        strip.empty();
        for (let j = 0; j < 20; j++) {
            const symbol = slotSymbols[Math.floor(Math.random() * slotSymbols.length)];
            strip.append(`<div class="slot-symbol-item">${symbol}</div>`);
        }
        strip.css('transition', 'none');
        strip.css('top', '0px');
    }
}

window.openCasinoTop = () => {
    $('#slot-modal').addClass('hidden');
    $('#poker-modal').addClass('hidden');
    $('#casino-modal').removeClass('hidden');
};

window.openCasinoGame = async (game) => {
    const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
    const coins = userDoc.data().coins || 0;
    if (game === 'slot') {
        $('#casino-modal').addClass('hidden');
        $('#slot-modal').removeClass('hidden');
        initReelStrips();
        $('#slot-coins').text(String(coins).padStart(4, '0'));
        $('#slot-result-display').addClass('hidden');
        if (hasSpecialSpin) {
            $('#special-spin-indicator').removeClass('hidden');
        } else {
            $('#special-spin-indicator').addClass('hidden');
        }
        updateBoostedSpinsDisplay();
    } else if (game === 'poker') {
        $('#casino-modal').addClass('hidden');
        $('#poker-modal').removeClass('hidden');
        pokerInit(coins);
    }
};

window.openCasinoFromMenu = async () => {
    const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
    const coins = userDoc.data().coins || 0;
    $('#casino-coins-top').text(String(coins).padStart(4, '0'));
    $('#casino-modal').removeClass('hidden');
};

function spinReel(reelId, targetSymbol, duration) {
    return new Promise((resolve) => {
        const strip = $(`#strip${reelId}`);

        strip.empty();
        strip.css({ transition: 'none', top: '0px' });

        const TOTAL = 40;
        const stopIndex = TOTAL - 1;
        for (let j = 0; j < TOTAL; j++) {
            const sym = (j === stopIndex)
                ? targetSymbol
                : slotSymbols[Math.floor(Math.random() * slotSymbols.length)];
            strip.append(`<div class="slot-symbol-item">${sym}</div>`);
        }

        const symH = strip.find('.slot-symbol-item').first().outerHeight() || 150;

        const frames = [];
        const accelFrames  = Math.floor(TOTAL * 0.15);
        const decelFrames  = Math.floor(TOTAL * 0.25);
        const constFrames  = TOTAL - accelFrames - decelFrames;
        const minInterval  = 16;
        const maxInterval  = 120;

        for (let i = 0; i < accelFrames; i++) {
            frames.push(maxInterval - (maxInterval - minInterval) * (i / accelFrames));
        }
        for (let i = 0; i < constFrames; i++) {
            frames.push(minInterval);
        }
        for (let i = 0; i < decelFrames; i++) {
            frames.push(minInterval + (maxInterval - minInterval) * ((i + 1) / decelFrames));
        }

        let frame = 0;
        let currentTop = 0;

        function nextFrame() {
            if (frame >= TOTAL) {
                strip.css({ transition: 'none', top: `-${symH * stopIndex}px` });
                resolve();
                return;
            }
            currentTop -= symH;
            strip.css({ transition: 'none', top: `${currentTop}px` });
            const interval = frames[frame] || minInterval;
            frame++;
            setTimeout(nextFrame, interval);
        }

        playSlotSpinSound(frames.length);
        setTimeout(nextFrame, 0);
    });
}

$('#spin-btn').on('click', async () => {

    if (isSpinning) return;
    
    const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
    const currentCoins = userDoc.data().coins || 0;
    const betCost = 10 * currentBet;
    
    if (currentCoins < betCost) {
        alert(`❌ コインが足りません！（必要: ${betCost}コイン）`);
        return;
    }
    
    isSpinning = true;
    $('#spin-btn').prop('disabled', true).html('<div style="font-size:20px;">🎰 SPINNING...</div>');
    $('#reach-effect').addClass('hidden');
    $('#slot-result-display').addClass('hidden');
    hideSlotEffect();

    await setDoc(doc(db, "users", auth.currentUser.uid), { coins: currentCoins - betCost }, { merge: true });
    $('#slot-coins').text(String(currentCoins - betCost).padStart(4, '0'));

    const isBoosted = boostedSpinsRemaining > 0;
    const winRate   = isBoosted ? 0.60 : 0.18;
    const rand      = Math.random();
    const willWin      = rand < winRate;
    const willReachMiss = !willWin && rand < (winRate + 0.12);
    let results;

    if (willWin) {
        const sr = Math.random();
        let winSymbol;
        if (isBoosted) {
            if (sr < 0.20) winSymbol = '🍒';
            else if (sr < 0.38) winSymbol = '🍋';
            else if (sr < 0.56) winSymbol = '🍊';
            else if (sr < 0.72) winSymbol = '🍇';
            else if (sr < 0.86) winSymbol = '⭐';
            else if (sr < 0.94) winSymbol = '💎';
            else winSymbol = '🎁';
        } else {
            if (sr < 0.33) winSymbol = '🍒';
            else if (sr < 0.58) winSymbol = '🍋';
            else if (sr < 0.74) winSymbol = '🍊';
            else if (sr < 0.83) winSymbol = '🍇';
            else if (sr < 0.90) winSymbol = '⭐';
            else if (sr < 0.95) winSymbol = '💎';
            else winSymbol = '🎁';
        }
        results = [winSymbol, winSymbol, winSymbol];
    } else if (willReachMiss) {
        const reachSymbol = slotSymbols[Math.floor(Math.random() * slotSymbols.length)];
        let missSymbol;
        do { missSymbol = slotSymbols[Math.floor(Math.random() * slotSymbols.length)]; }
        while (missSymbol === reachSymbol);
        results = [reachSymbol, reachSymbol, missSymbol];
    } else {
        do {
            results = [
                slotSymbols[Math.floor(Math.random() * slotSymbols.length)],
                slotSymbols[Math.floor(Math.random() * slotSymbols.length)],
                slotSymbols[Math.floor(Math.random() * slotSymbols.length)],
            ];
        } while (results[0] === results[1] || results[1] === results[2] || results[0] === results[2]);
    }

    const isWin       = willWin;
    const isDiamond   = isWin && results[0] === '💎';
    const isSevenStar = isWin && results[0] === '⭐';
    const isReach     = willReachMiss;

    const showPreEffect  = isDiamond ? true
                         : isSevenStar ? Math.random() < 0.50
                         : isWin       ? Math.random() < 0.20
                         : false;
    const showReachEffect = isReach && Math.random() < 0.30;

    if (showPreEffect) {
        if (isDiamond)   { showSlotEffect('jackpot'); await wait(600); }
        else if (isSevenStar) { showSlotEffect('star'); await wait(400); }
        else             { showSlotEffect('win');     await wait(300); }
        hideSlotEffect();
    }

    await spinReel(1, results[0]);
    playReelStopSound(0);
    await wait(250);

    await spinReel(2, results[1]);
    playReelStopSound(1);

    if (showReachEffect) {
        await wait(200);
        $('#reach-effect').removeClass('hidden');
        showSlotEffect('reach');
        playReachSound();
        await wait(800);
        hideSlotEffect();
    } else {
        await wait(250);
    }

    await spinReel(3, results[2]);
    playReelStopSound(2);

    $('#reach-effect').addClass('hidden');
    await wait(350);

    checkSlotResult(results, currentCoins - betCost, isWin, willReachMiss, isDiamond, isSevenStar);
});

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

function showSlotEffect(type) {
    const $container = $('#slot-effect-container');
    if (!$container.length) return;
    $container.removeClass('hidden effect-jackpot effect-star effect-win effect-reach');
    $container.addClass(`effect-${type}`).removeClass('hidden');
}
function hideSlotEffect() {
    $('#slot-effect-container').addClass('hidden');
}

async function checkSlotResult(results, currentCoins, isWin, isReachMiss, isDiamond, isSevenStar) {
    const [r1, r2, r3] = results;
    
    if (boostedSpinsRemaining > 0) {
        boostedSpinsRemaining--;
        updateBoostedSpinsDisplay();
    }
    
    const betCost = 10 * currentBet;
    const resetBtn = () => {
        isSpinning = false;
        $('#spin-btn').prop('disabled', false).html(`<div style="font-size:24px; font-weight:bold; text-shadow:2px 2px 4px rgba(0,0,0,0.3);">🎰 SPIN</div><div id="spin-btn-cost" style="font-size:12px; margin-top:5px; opacity:0.9;">- ${betCost} COINS -</div>`);
    };

    if (r1 === r2 && r2 === r3) {
        if (r1 === '🎁') {
            boostedSpinsRemaining = 10;
            updateBoostedSpinsDisplay();
            if (Math.random() < 0.70) {
                showSlotEffect('boosted');
                playBoostedSound();
                await wait(1000);
                hideSlotEffect();
            }
            $('#slot-result-display').addClass('hidden');
            resetBtn();
            return;
        }

        let basePayout = slotPayouts[r1];
        let payout = basePayout * 10 * currentBet;

        if (hasSpecialSpin) {
            payout *= 2;
            hasSpecialSpin = false;
            $('#special-spin-indicator').addClass('hidden');
        }
        if (r1 === '💎') {
            hasSpecialSpin = true;
            $('#special-spin-indicator').removeClass('hidden');
        }

        const newCoins = currentCoins + payout;
        await setDoc(doc(db, "users", auth.currentUser.uid), { coins: newCoins }, { merge: true });
        $('#slot-coins').text(String(newCoins).padStart(4, '0'));
        $('#slot-win-amount').text(`+${String(payout).padStart(4, '0')}`);
        $('#slot-result-display').removeClass('hidden');

        const showWinEffect = (r1 === '💎') ? true
                            : (r1 === '⭐') ? Math.random() < 0.60
                            : Math.random() < 0.25;
        if (showWinEffect) {
            if (r1 === '💎')  { showSlotEffect('jackpot'); playJackpotSound(); }
            else if (r1 === '⭐') { showSlotEffect('star'); playWinSound(); }
            else              { showSlotEffect('win');     playWinSound(); }
            await wait(1800);
            hideSlotEffect();
        }

    } else if (isReachMiss) {
        if (Math.random() < 0.40) {
            showSlotEffect('miss');
            playMissSound();
            await wait(900);
            hideSlotEffect();
        }
        $('#slot-result-display').addClass('hidden');

    } else {
        $('#slot-result-display').addClass('hidden');
    }

    resetBtn();
}

function updateBoostedSpinsDisplay() {
    const $indicator = $('#boosted-spins-indicator');
    if (boostedSpinsRemaining > 0) {
        $indicator.text(`🔥 BOOSTED ×${boostedSpinsRemaining}`).removeClass('hidden');
    } else {
        $indicator.addClass('hidden');
    }
}

window.openLoginBonusFromMenu = () => openLoginBonusModal();

$('#claimBonusBtn').on('click', async () => {
    const $btn = $('#claimBonusBtn');
    $btn.prop('disabled', true).text('受け取り中...');
    
    const result = await claimLoginBonus();
    
    if (result.success) {
        $('#bonus-amount').text(`+${result.bonus}`);
        $('#bonus-current-coins').text(result.chips.toLocaleString());
        
        $('#bonus-claim-section').addClass('hidden');
        $('#bonus-already-claimed').removeClass('hidden');
        
        setTimeout(() => {
            alert('🎉 ' + result.message);
        }, 300);
    } else {
        alert('❌ ' + result.message);
        $btn.prop('disabled', false).text('受け取る');
    }
});


async function loadShopData(category) {
    const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
    const userData = userDoc.data();
    const userCoins = userData.coins || 0;
    const userChips = userData.chips || 0;
    const ownedItems = userData.ownedItems || [];
    
    const currentUserName = userData.name || 'あなた';
    const currentUserPhoto = userData.photo || DEFAULT_AVATAR;
    
    $('#user-coins').text(userCoins);
    $('#user-chips').text(userChips.toLocaleString());
    
    const $container = $('#shop-items').empty();
    
    shopItems.filter(item => item.category === category).forEach(item => {
        const owned = ownedItems.includes(item.id);
        
        const $item = $(`
            <div class="shop-item ${owned ? 'owned' : ''}" data-item-id="${item.id}" onclick="${owned ? '' : `purchaseItem('${item.id}')`}">
                <div class="shop-item-icon"><span class="sidebar-icon-tile" style="--tile-color:${item.tileColor};"><span class="material-symbols-outlined">${item.msIcon}</span></span></div>
                <div class="shop-item-name">${item.name}</div>
                ${owned ? 
                    '<div class="shop-item-owned">✅ 所持中</div>' :
                    `<div class="shop-item-price">💰 ${item.price}</div>`
                }
            </div>
        `);
        
        if (window.matchMedia('(max-width: 600px)').matches) {
            $item.attr('onclick', '');
            $item.on('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                if (owned) {
                    showItemPreview(item, currentUserName, currentUserPhoto);
                    $('#item-preview').data('previewId', item.id);
                    return;
                }
                const prevId = $('#item-preview').data('previewId');
                if (prevId !== item.id) {
                    showItemPreview(item, currentUserName, currentUserPhoto);
                    $('#item-preview').data('previewId', item.id);
                    setTimeout(() => {
                        const el = document.getElementById('item-preview');
                        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }, 100);
                } else {
                    window.purchaseItem(item.id);
                    resetItemPreview();
                }
            });
        } else {
            $item.on('mouseenter', function() {
                showItemPreview(item, currentUserName, currentUserPhoto);
            });
        }
        
        $container.append($item);
    });
    
    $container.on('mouseleave', function() {
        resetItemPreview();
    });
}

function resetItemPreview() {
    $('#item-preview').data('previewId', null).css('background', '');
    $('#preview-item-name').text('アイテムにマウスを乗せてね');
    $('#preview-item-desc').text('気になるアイテムをホバー（スマホはタップ）すると、ここに詳細が表示されます');
    $('#preview-message').removeClass('effect-fire effect-sparkle effect-lightning effect-rainbow effect-shadow effect-ice effect-toxic effect-gold');
    $('#preview-icon-container').removeClass('effect-fire effect-sparkle effect-lightning effect-rainbow effect-shadow effect-ice effect-toxic effect-gold');
    $('#preview-badge').empty();
}

function showItemPreview(item, userName, userPhoto) {
    $('#preview-item-name').text(item.name);
    $('#preview-item-desc').text(item.description);
    $('#preview-name').text(userName);
    $('#preview-icon').attr('src', userPhoto);
    
    $('#preview-message').removeClass('effect-fire effect-sparkle effect-lightning effect-rainbow effect-shadow effect-ice effect-toxic effect-gold');
    $('#preview-icon-container').removeClass('effect-fire effect-sparkle effect-lightning effect-rainbow effect-shadow effect-ice effect-toxic effect-gold');
    $('#preview-badge').empty();
    $('#item-preview').css('background', '');
    
    if (item.id === 'vip_badge' || item.id === 'star_badge' || item.id === 'crown_badge') {
        const badgeMap = {
            'vip_badge': { msIcon: 'workspace_premium', tileColor: '#ffd700', title: 'VIP' },
            'star_badge': { msIcon: 'star', tileColor: '#ffd700', title: 'スター' },
            'crown_badge': { msIcon: 'crown', tileColor: '#ffca28', title: 'プレミアム' }
        };
        const badge = badgeMap[item.id];
        $('#preview-badge').html(`<span class="user-badge" title="${badge.title}"><span class="sidebar-icon-tile tile-xs" style="--tile-color:${badge.tileColor};"><span class="material-symbols-outlined">${badge.msIcon}</span></span></span>`);
        
    } else if (item.id === 'fire_effect') {
        $('#preview-message').addClass('effect-fire');
        
    } else if (item.id === 'sparkle_effect') {
        $('#preview-message').addClass('effect-sparkle');
        
    } else if (item.id === 'lightning_effect') {
        $('#preview-message').addClass('effect-lightning');
        
    } else if (item.id === 'rainbow_effect') {
        $('#preview-message').addClass('effect-rainbow');
        
    } else if (item.id === 'shadow_effect') {
        $('#preview-message').addClass('effect-shadow');
        
    } else if (item.id === 'ice_effect') {
        $('#preview-message').addClass('effect-ice');
        
    } else if (item.id === 'toxic_effect') {
        $('#preview-message').addClass('effect-toxic');
        
    } else if (item.id === 'gold_effect') {
        $('#preview-message').addClass('effect-gold');
        
    } else if (item.id === 'rainbow_theme') {
        $('#item-preview').css('background', 'linear-gradient(135deg, #ff6b6b88, #f093fb88, #4facfe88, #43e97b88, #feca5788)');
        $('#preview-item-desc').text('チャット背景が虹色に変わります');
    } else if (item.id === 'heart_theme') {
        $('#item-preview').css('background', 'linear-gradient(135deg, #f5576c66, #f093fb66)');
        $('#preview-item-desc').text('チャット背景がピンク色に変わります');
    }
}

window.purchaseItem = async (itemId) => {
    const item = shopItems.find(i => i.id === itemId);
    if (!item) return;
    
    if (!confirm(`${item.icon} ${item.name}\n${item.description}\n\n💰 ${item.price}コインで購入しますか？`)) {
        return;
    }
    
    try {
        const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
        const userData = userDoc.data();
        const userCoins = userData.coins || 0;
        const ownedItems = userData.ownedItems || [];
        
        if (userCoins < item.price) {
            alert('❌ コインが足りません！');
            return;
        }
        
        if (ownedItems.includes(itemId)) {
            alert('✅ すでに所持しています！');
            return;
        }
        
        await setDoc(doc(db, "users", auth.currentUser.uid), {
            coins: userCoins - item.price,
            ownedItems: arrayUnion(itemId)
        }, { merge: true });
        
        alert(`🎉 ${item.name}を購入しました！`);
        
        if (itemId === 'rainbow_theme' || itemId === 'heart_theme') {
            applyUserTheme();
            alert(`✨ テーマが適用されました！\n\n※ 複数のテーマを持っている場合、\n最後に購入したものが優先されます。`);
        }
        
        loadShopData();
        
    } catch (error) {
        console.error('Purchase error:', error);
        alert('❌ 購入に失敗しました: ' + error.message);
    }
};


window.openShopFromMenu = (category) => {
    $('#shop-modal').removeClass('hidden');
    switchShopCategory(category || shopActiveCategory || 'badge');
};

window.switchShopCategory = (cat) => {
    shopActiveCategory = cat;
    $('.shop-cat-tab-btn').removeClass('active');
    $(`.shop-cat-tab-btn[data-cat="${cat}"]`).addClass('active');

    if (cat === 'stamp') {
        $('#shop-panel-items').addClass('hidden');
        $('#shop-panel-stamp').removeClass('hidden');
        loadStampShopData();
    } else {
        $('#shop-panel-stamp').addClass('hidden');
        $('#shop-panel-items').removeClass('hidden');
        loadShopData(cat);
    }
};


// ========== スタンプショップ（チップ専用・アイテムショップとは独立。LINEのようにパック単位で販売） ==========

let stampShopTab = 'official'; // 'official' | 'custom'
let customPacksCache = null; // Firestoreからの自作パック一覧キャッシュ
let currentPreviewPack = null; // 詳細モーダルで表示中のパック
let customPackDraftStamps = []; // 自作パック投稿フォームで積み上げ中のスタンプ画像

async function loadStampShopData() {
    const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
    const userData = userDoc.data() || {};
    const userChips = userData.chips || 0;
    const ownedPacks = userData.ownedPacks || [];

    $('#user-chips').text(userChips.toLocaleString());

    const $container = $('#stamp-shop-items').empty();

    if (stampShopTab === 'official') {
        STAMP_PACKS.forEach(pack => renderPackCard($container, pack, ownedPacks, false));
    } else {
        if (customPacksCache === null) {
            $container.html('<div style="grid-column:1/-1; text-align:center; color:var(--txt-m); padding:20px;">読み込み中...</div>');
            try {
                const snap = await getDocs(query(collection(db, "stampPacks"), orderBy("createdAt", "desc"), limit(60)));
                customPacksCache = snap.docs.map(d => ({ id: d.id, ...d.data() }));
            } catch (error) {
                console.error('Load custom packs error:', error);
                customPacksCache = [];
            }
            $container.empty();
        }
        if (customPacksCache.length === 0) {
            $container.html('<div style="grid-column:1/-1; text-align:center; color:var(--txt-m); padding:20px;">まだ自作スタンプがありません。一番乗りで投稿してみよう！</div>');
        } else {
            const visible = customPacksCache.filter(pack =>
                (pack.reports || []).length < STAMP_REPORT_HIDE_THRESHOLD || pack.creatorUid === auth.currentUser.uid
            );
            if (visible.length === 0) {
                $container.html('<div style="grid-column:1/-1; text-align:center; color:var(--txt-m); padding:20px;">表示できるスタンプがありません</div>');
            } else {
                visible.forEach(pack => renderPackCard($container, pack, ownedPacks, true));
            }
        }
    }
}

function renderPackCard($container, pack, ownedPacks, isCustom) {
    const owned = ownedPacks.includes(pack.id) || (isCustom && pack.creatorUid === auth.currentUser.uid);
    const thumb = pack.thumbnail || (pack.stamps && pack.stamps[0] && pack.stamps[0].url) || '';

    const $item = $(`
        <div class="stamp-pack-tile ${owned ? 'owned' : ''}" data-pack-id="${pack.id}">
            <div class="stamp-pack-tile-thumb"><img src="${thumb}" alt="${pack.name}">${owned ? '<span class="stamp-pack-tile-owned">✓</span>' : ''}</div>
            <div class="stamp-pack-tile-name">${pack.name}</div>
        </div>
    `);
    $item.on('click', () => openPackDetail(pack, isCustom, owned));
    $container.append($item);
}

function openPackDetail(pack, isCustom, owned) {
    currentPreviewPack = { ...pack, __isCustom: isCustom };
    const thumb = pack.thumbnail || (pack.stamps && pack.stamps[0] && pack.stamps[0].url) || '';

    $('#pack-detail-thumb').attr('src', thumb);
    $('#pack-detail-title').text(pack.name);
    $('#pack-detail-desc').text(pack.description || (isCustom ? `by ${pack.creatorName || '名無し'}` : ''));
    $('#pack-detail-count').text(`${(pack.stamps || []).length}個入り`);

    const $grid = $('#pack-detail-grid').empty();
    (pack.stamps || []).forEach(s => {
        $grid.append(`<img src="${s.url}" alt="${s.name || ''}" class="stamp-item" style="cursor:default;">`);
    });

    const alreadyOwned = owned;
    if (alreadyOwned) {
        $('#pack-detail-buy-btn').addClass('hidden');
        $('#pack-detail-owned-label').removeClass('hidden');
    } else {
        $('#pack-detail-buy-btn').removeClass('hidden').text(`🎫 ${pack.price} で購入`);
        $('#pack-detail-owned-label').addClass('hidden');
    }

    if (isCustom && pack.creatorUid !== auth.currentUser.uid) {
        const alreadyReported = (pack.reports || []).includes(auth.currentUser.uid);
        $('#pack-detail-report-btn').removeClass('hidden')
            .prop('disabled', alreadyReported)
            .text(alreadyReported ? '🚩 通報済み' : '🚩 このスタンプを通報');
    } else {
        $('#pack-detail-report-btn').addClass('hidden');
    }

    $('#stamp-pack-detail-modal').removeClass('hidden');
}

window.reportCurrentPack = async () => {
    if (!currentPreviewPack || !currentPreviewPack.__isCustom) return;
    if (!confirm('このスタンプを不適切な内容として通報しますか？')) return;

    try {
        await updateDoc(doc(db, "stampPacks", currentPreviewPack.id), {
            reports: arrayUnion(auth.currentUser.uid)
        });
        alert('🚩 通報しました。ご協力ありがとうございます');
        $('#pack-detail-report-btn').prop('disabled', true).text('🚩 通報済み');
        customPacksCache = null;
    } catch (error) {
        console.error('Report pack error:', error);
        alert('❌ 通報に失敗しました: ' + error.message);
    }
};

window.purchaseCurrentPack = async () => {
    if (!currentPreviewPack) return;
    const pack = currentPreviewPack;

    if (!confirm(`${pack.name}（${(pack.stamps || []).length}個入り）\n\n🎫 ${pack.price}チップで購入しますか？`)) {
        return;
    }

    try {
        const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
        const userData = userDoc.data() || {};
        const userChips = userData.chips || 0;
        const ownedPacks = userData.ownedPacks || [];

        if (ownedPacks.includes(pack.id)) {
            alert('✅ すでに所持しています！');
            return;
        }
        if (userChips < pack.price) {
            alert('❌ チップが足りません！ログインボーナスで貯めよう');
            return;
        }

        await setDoc(doc(db, "users", auth.currentUser.uid), {
            chips: userChips - pack.price,
            ownedPacks: arrayUnion(pack.id)
        }, { merge: true });

        alert(`🎉 「${pack.name}」を購入しました！`);

        $('#stamp-pack-detail-modal').addClass('hidden');
        loadStampShopData();
        initStampPicker();

    } catch (error) {
        console.error('Purchase pack error:', error);
        alert('❌ 購入に失敗しました: ' + error.message);
    }
};

window.switchStampShopTab = (tab) => {
    stampShopTab = tab;
    $('.stamp-shop-tab-btn').removeClass('active');
    $(`.stamp-shop-tab-btn[data-tab="${tab}"]`).addClass('active');
    loadStampShopData();
};

// 後方互換用エイリアス：以前は別モーダルだったが、今は統合ショップの「スタンプ」タブを開く
window.openStampShopFromMenu = () => {
    openShopFromMenu('stamp');
};


// ========== ユーザーブロック ==========

window.blockUser = async (uid) => {
    if (!confirm('このユーザーをブロックしますか？相手のメッセージが見えなくなります')) return;
    try {
        await setDoc(doc(db, "users", auth.currentUser.uid), { blockedUsers: arrayUnion(uid) }, { merge: true });
        myBlockedUsers.push(uid);
        alert('🚫 ブロックしました');
        showProfile(uid);
    } catch (error) {
        console.error('Block user error:', error);
        alert('❌ ブロックに失敗しました: ' + error.message);
    }
};

window.unblockUser = async (uid) => {
    try {
        await setDoc(doc(db, "users", auth.currentUser.uid), { blockedUsers: arrayRemove(uid) }, { merge: true });
        myBlockedUsers = myBlockedUsers.filter(id => id !== uid);
        alert('🔓 ブロックを解除しました');
        showProfile(uid);
    } catch (error) {
        console.error('Unblock user error:', error);
        alert('❌ 解除に失敗しました: ' + error.message);
    }
};


// ========== 管理者：BAN・モデレーションパネル ==========

window.adminBanUser = async (uid, name) => {
    if (!isCurrentUserAdmin) return;
    if (!confirm(`${name} をBANしますか？以後このサイトを利用できなくなります`)) return;
    try {
        await setDoc(doc(db, "users", uid), { banned: true }, { merge: true });
        alert(`⛔ ${name} をBANしました`);
    } catch (error) {
        console.error('Ban user error:', error);
        alert('❌ BANに失敗しました: ' + error.message);
    }
};

window.adminUnbanUser = async (uid, name) => {
    if (!isCurrentUserAdmin) return;
    try {
        await setDoc(doc(db, "users", uid), { banned: false }, { merge: true });
        alert(`✅ ${name} のBANを解除しました`);
        openAdminPanel();
    } catch (error) {
        console.error('Unban user error:', error);
        alert('❌ 解除に失敗しました: ' + error.message);
    }
};

window.adminDeletePack = async (packId, name) => {
    if (!isCurrentUserAdmin) return;
    if (!confirm(`「${name}」を削除しますか？この操作は取り消せません`)) return;
    try {
        await deleteDoc(doc(db, "stampPacks", packId));
        alert('🗑️ 削除しました');
        customPacksCache = null;
        openAdminPanel();
    } catch (error) {
        console.error('Delete pack error:', error);
        alert('❌ 削除に失敗しました: ' + error.message);
    }
};

window.openAdminPanel = async () => {
    if (!isCurrentUserAdmin) return;
    $('#admin-panel-modal').removeClass('hidden');
    const $list = $('#admin-reported-packs').html('<div style="color:var(--txt-m); padding:10px;">読み込み中...</div>');

    try {
        const snap = await getDocs(query(collection(db, "stampPacks"), orderBy("createdAt", "desc"), limit(100)));
        const reported = snap.docs
            .map(d => ({ id: d.id, ...d.data() }))
            .filter(p => (p.reports || []).length > 0)
            .sort((a, b) => (b.reports || []).length - (a.reports || []).length);

        $list.empty();
        if (reported.length === 0) {
            $list.html('<div style="color:var(--txt-m); padding:10px;">現在、通報されているスタンプパックはありません</div>');
        } else {
            reported.forEach(pack => {
                const thumb = pack.thumbnail || (pack.stamps && pack.stamps[0] && pack.stamps[0].url) || '';
                $list.append(`
                    <div style="display:flex; align-items:center; gap:12px; padding:10px; border-bottom:1px solid rgba(255,255,255,0.08);">
                        <img src="${thumb}" style="width:40px; height:40px; object-fit:contain;">
                        <div style="flex:1;">
                            <div style="font-weight:bold; font-size:13px;">${escapeHTML(pack.name)}</div>
                            <div style="font-size:11px; color:var(--txt-m);">by ${escapeHTML(pack.creatorName || '名無し')} ・ 🚩${(pack.reports || []).length}件通報</div>
                        </div>
                        <button onclick="adminDeletePack('${pack.id}', '${escapeHTML(pack.name).replace(/'/g, "\\'")}')" style="padding:6px 12px; background:#7f1d1d; color:#fff; border:none; border-radius:6px; font-size:12px; cursor:pointer;">削除</button>
                    </div>
                `);
            });
        }
    } catch (error) {
        console.error('Load admin panel error:', error);
        $list.html('<div style="color:#ff6b6b; padding:10px;">読み込みに失敗しました</div>');
    }
};


// ========== 自作スタンプパックの投稿 ==========

function renderCustomPackDraftList() {
    const $list = $('#custom-pack-draft-list').empty();
    customPackDraftStamps.forEach((s, i) => {
        $list.append(`
            <div class="custom-draft-stamp">
                <img src="${s.url}" alt="">
                <span class="material-symbols-outlined custom-draft-remove" onclick="removeCustomPackDraftStamp(${i})">close</span>
            </div>
        `);
    });
    if (customPackDraftStamps.length < CUSTOM_PACK_MAX_STAMPS) {
        $list.append(`
            <label class="custom-draft-add">
                <span class="material-symbols-outlined">add</span>
                <input type="file" accept="image/*" style="display:none;" onchange="addCustomPackDraftStamp(this.files[0])">
            </label>
        `);
    }
    $('#custom-pack-draft-count').text(`${customPackDraftStamps.length} / ${CUSTOM_PACK_MAX_STAMPS}（最低${CUSTOM_PACK_MIN_STAMPS}個から投稿できます）`);
}

window.addCustomPackDraftStamp = async (file) => {
    if (!file) return;
    if (customPackDraftStamps.length >= CUSTOM_PACK_MAX_STAMPS) return;
    const url = await baseUpload(file, true, 'スタンプをアップロード中');
    if (url) {
        customPackDraftStamps.push({ url, name: '' });
        renderCustomPackDraftList();
    }
};

window.removeCustomPackDraftStamp = (index) => {
    customPackDraftStamps.splice(index, 1);
    renderCustomPackDraftList();
};

async function checkCanSubmitPack() {
    const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
    const userData = userDoc.exists() ? userDoc.data() : {};

    const lastSubmitted = userData.lastPackSubmittedAt;
    if (lastSubmitted) {
        const elapsed = Date.now() - lastSubmitted.toDate().getTime();
        if (elapsed < CUSTOM_PACK_SUBMIT_COOLDOWN_MS) {
            const remainingMs = CUSTOM_PACK_SUBMIT_COOLDOWN_MS - elapsed;
            const remainingH = Math.ceil(remainingMs / (60 * 60 * 1000));
            return { allowed: false, reason: `次のスタンプ投稿まであと約${remainingH}時間お待ちください（乱用防止のため24時間に1回までです）` };
        }
    }

    const ownedSnap = await getDocs(query(collection(db, "stampPacks"), where("creatorUid", "==", auth.currentUser.uid)));
    if (ownedSnap.size >= CUSTOM_PACK_MAX_PER_USER) {
        return { allowed: false, reason: `1人が投稿できる自作スタンプは最大${CUSTOM_PACK_MAX_PER_USER}個までです。既存のパックを整理してから投稿してください` };
    }

    return { allowed: true };
}

window.openCustomPackCreateModal = async () => {
    const check = await checkCanSubmitPack();
    if (!check.allowed) {
        alert('⏳ ' + check.reason);
        return;
    }

    customPackDraftStamps = [];
    $('#custom-pack-name-input').val('');
    $('#custom-pack-price-input').val(CUSTOM_PACK_MIN_PRICE);
    $('#custom-pack-thumb-preview').attr('src', '').addClass('hidden');
    $('#custom-pack-thumb-input').val('');
    renderCustomPackDraftList();
    $('#stamp-pack-create-modal').removeClass('hidden');
};

$(document).on('change', '#custom-pack-thumb-input', async function() {
    const file = this.files[0];
    if (!file) return;
    const url = await baseUpload(file, true, 'サムネイルをアップロード中');
    if (url) {
        $('#custom-pack-thumb-preview').attr('src', url).removeClass('hidden').data('url', url);
    }
});

window.submitCustomStampPack = async () => {
    const name = $('#custom-pack-name-input').val().trim();
    const thumbUrl = $('#custom-pack-thumb-preview').data('url');
    let price = parseInt($('#custom-pack-price-input').val(), 10);

    if (!name) { alert('パック名を入力してください'); return; }
    if (customPackDraftStamps.length < CUSTOM_PACK_MIN_STAMPS) {
        alert(`スタンプを最低${CUSTOM_PACK_MIN_STAMPS}個は追加してください`);
        return;
    }
    if (isNaN(price)) price = CUSTOM_PACK_MIN_PRICE;
    price = Math.min(CUSTOM_PACK_MAX_PRICE, Math.max(CUSTOM_PACK_MIN_PRICE, price));

    // 投稿ボタンを押すまでの間に条件が変わっている可能性があるので、送信直前にもう一度チェックする
    const check = await checkCanSubmitPack();
    if (!check.allowed) {
        alert('⏳ ' + check.reason);
        return;
    }

    try {
        const userData = (await getDoc(doc(db, "users", auth.currentUser.uid))).data() || {};
        const ref = await addDoc(collection(db, "stampPacks"), {
            name,
            thumbnail: thumbUrl || customPackDraftStamps[0].url,
            price,
            stamps: customPackDraftStamps,
            creatorUid: auth.currentUser.uid,
            creatorName: userData.name || auth.currentUser.displayName || '名無し',
            createdAt: serverTimestamp(),
        });

        // 作った本人はすぐ使えるように所持済み扱いにし、投稿クールダウン用の時刻も記録する
        await setDoc(doc(db, "users", auth.currentUser.uid), {
            ownedPacks: arrayUnion(ref.id),
            lastPackSubmittedAt: serverTimestamp()
        }, { merge: true });

        alert(`🎉 「${name}」を投稿しました！みんなが購入できるようになります`);

        customPacksCache = null; // 一覧を再取得させる
        $('#stamp-pack-create-modal').addClass('hidden');
        stampShopTab = 'custom';
        $('.stamp-shop-tab-btn').removeClass('active');
        $(`.stamp-shop-tab-btn[data-tab="custom"]`).addClass('active');
        loadStampShopData();
        initStampPicker();

    } catch (error) {
        console.error('Submit custom pack error:', error);
        alert('❌ 投稿に失敗しました: ' + error.message);
    }
};

$('#toggleNotificationBtn').on('click', async () => {
    if (!('Notification' in window)) {
        alert('このブラウザはプッシュ通知に対応していません');
        return;
    }
    if (Notification.permission === 'denied') {
        alert('通知がブロックされています。ブラウザの設定から許可してください');
        return;
    }
    if (Notification.permission !== 'granted') {
        const perm = await Notification.requestPermission();
        updatePushPermissionMsg();
        if (perm === 'granted') {
            $('#notificationBtnText').text('✅ 通知が許可されました');
        }
    }
});

function updateNotificationButtonUI() {
    updatePushPermissionMsg();
}

window.react = async (id, emoji, currentJson) => {
    const colRef = currentRoomId ? collection(db, "rooms", currentRoomId, "messages") : collection(db, "chats");
    const users = (currentJson && currentJson[emoji]) || [];
    await updateDoc(doc(colRef, id), { [`reactions.${emoji}`]: users.includes(auth.currentUser.uid) ? arrayRemove(auth.currentUser.uid) : arrayUnion(auth.currentUser.uid) });
};

const reactionEmojis = [
    '👍', '❤️', '😂', '😮', '😢', '😡',
    '🙏', '👏', '🎉', '🔥', '✨', '💯',
    '👀', '🤔', '😅', '😊', '🥰', '😎',
    '🤩', '😇', '🤗', '🙌', '✅', '❌',
    '⭐', '💪', '👌', '🎊', '🎈', '💕'
];

window.openReactionPicker = (msgId, event, currentReactions) => {
    if (event && event.stopPropagation) event.stopPropagation();
    const $picker = $('#reaction-picker');
    
    $picker.empty();
    reactionEmojis.forEach(emoji => {
        const $btn = $(`<div class="reaction-emoji">${emoji}</div>`);
        $btn.on('click touchend', function(e) {
            e.preventDefault();
            e.stopPropagation();
            react(msgId, emoji, currentReactions);
            $picker.addClass('hidden');
        });
        $picker.append($btn);
    });
    
    $picker.css({ left: '0px', top: '0px', visibility: 'hidden' }).removeClass('hidden');
    const pickerWidth = $picker.outerWidth();
    const pickerHeight = $picker.outerHeight();
    $picker.addClass('hidden').css('visibility', 'visible');
    
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const padding = 10;
    
    let anchorX, anchorY;
    if (event && event.clientX != null && event.clientX !== 0) {
        anchorX = event.clientX;
        anchorY = event.clientY;
    } else if (event && event.target && event.target.getBoundingClientRect) {
        const rect = event.target.getBoundingClientRect();
        anchorX = rect.left;
        anchorY = rect.bottom;
    } else {
        anchorX = windowWidth / 2;
        anchorY = windowHeight / 2;
    }
    
    let left = anchorX;
    let top = anchorY + 5;
    
    if (left + pickerWidth > windowWidth - padding) left = windowWidth - pickerWidth - padding;
    if (left < padding) left = padding;
    if (top + pickerHeight > windowHeight - padding) top = anchorY - pickerHeight - 5;
    if (top < padding) top = padding;
    
    $picker.css({ left: left + 'px', top: top + 'px' }).removeClass('hidden');
};

$(document).on('click', function(e) {
    if (!$(e.target).closest('#reaction-picker, .op-btn').length) {
        $('#reaction-picker').addClass('hidden');
    }
});

window.deleteMsg = async (id) => {
    if(confirm("このメッセージを削除しますか？")) {
        const colRef = currentRoomId ? collection(db, "rooms", currentRoomId, "messages") : collection(db, "chats");
        await deleteDoc(doc(colRef, id));
    }
};

window.setEdit = (id, text) => {
    editTargetId = id;
    $("#messageInput").val(text).focus();
    $("#edit-indicator").removeClass("hidden");
    $("#reply-preview").addClass("hidden");
    replyTarget = null;
};
window.cancelEdit = () => { editTargetId = null; $("#messageInput").val(""); $("#edit-indicator").addClass("hidden"); };
$("#cancel-edit").on("click", cancelEdit);

$("#sendBtn").on("click", send);
$("#messageInput").on("keydown", (e) => { if (e.key === "Enter" && !e.shiftKey) { e.preventDefault(); send(); } });
$("#imgBtn").on("click", () => $("#real_file_input").click());
$("#stampBtn").on("click", () => { initStampPicker(); $("#stamp-modal").removeClass("hidden"); });

$("#real_file_input").on("change", (e) => uploadImageFile(e.target.files[0]));
$("#real_avatar_input").on("change", (e) => uploadAvatarFile(e.target.files[0]));
$("#real_banner_input").on("change", (e) => uploadBannerFile(e.target.files[0]));
$("#remove-img-btn").on("click", () => { pendingImageUrl = null; $("#upload-preview-container").addClass("hidden"); });

window.setReply = (id, name, text) => { 
    cancelEdit();
    replyTarget = { id, name, text: text.substring(0, 20) + "..." }; 
    $("#reply-user-p").text(name); $("#reply-preview").removeClass("hidden"); $("#messageInput").focus(); 
};
$("#cancel-reply").on("click", () => { replyTarget = null; $("#reply-preview").addClass("hidden"); });
window.scrollToMsg = (id) => { document.getElementById(`msg-${id}`)?.scrollIntoView({ behavior: 'smooth', block: 'center' }); };

window.showProfile = async (uid) => {
    const snap = await getDoc(doc(db, "users", uid)); 
    if (!snap.exists()) return;
    const d = snap.data(); 
    
    $("#viewName").text(d.name || "ゲスト"); 
    $("#viewAvatar").attr("src", d.photo || DEFAULT_AVATAR); 
    $("#viewBanner").attr("src", d.banner || DEFAULT_BANNER); 
    $("#viewBio").text(d.bio || "No bio.");
    if (d.favoriteSong) {
        $("#viewFavoriteSongSection").removeClass("hidden");
        renderSpotifySongCard(d.favoriteSong, $("#viewFavoriteSong"));
    } else {
        $("#viewFavoriteSongSection").addClass("hidden");
    }
    
    const statusClass = getUserOnlineStatus(uid);
    $("#viewStatusDot").removeClass('online offline').addClass(statusClass);
    
    const equipped = d.equipped || {};
    $("#viewAvatarContainer").removeClass('effect-fire effect-sparkle effect-lightning effect-rainbow effect-shadow effect-ice effect-toxic effect-gold');
    
    if (equipped.effect === 'fire_effect') $("#viewAvatarContainer").addClass('effect-fire');
    else if (equipped.effect === 'sparkle_effect') $("#viewAvatarContainer").addClass('effect-sparkle');
    else if (equipped.effect === 'lightning_effect') $("#viewAvatarContainer").addClass('effect-lightning');
    else if (equipped.effect === 'rainbow_effect') $("#viewAvatarContainer").addClass('effect-rainbow');
    else if (equipped.effect === 'shadow_effect') $("#viewAvatarContainer").addClass('effect-shadow');
    else if (equipped.effect === 'ice_effect') $("#viewAvatarContainer").addClass('effect-ice');
    else if (equipped.effect === 'toxic_effect') $("#viewAvatarContainer").addClass('effect-toxic');
    else if (equipped.effect === 'gold_effect') $("#viewAvatarContainer").addClass('effect-gold');
    
    const $badges = $("#viewBadges").empty();
    const viewBadgeMap = {
        'vip_badge': { msIcon: 'workspace_premium', tileColor: '#ffd700', title: 'VIP' },
        'star_badge': { msIcon: 'star', tileColor: '#ffd700', title: 'スター' },
        'crown_badge': { msIcon: 'crown', tileColor: '#ffca28', title: 'プレミアム' }
    };
    if (viewBadgeMap[equipped.badge]) {
        const badge = viewBadgeMap[equipped.badge];
        $badges.append(`<span class="user-badge" title="${badge.title}"><span class="sidebar-icon-tile tile-xs" style="--tile-color:${badge.tileColor};"><span class="material-symbols-outlined">${badge.msIcon}</span></span></span>`);
    }
    
    const $actionBox = $("#prof-action-box").empty();
    if (uid !== auth.currentUser.uid) {
        const reqId = [auth.currentUser.uid, uid].sort().join("_");
        const rSnap = await getDoc(doc(db, "friendRequests", reqId));
        if (!rSnap.exists()) $actionBox.append(`<button onclick="sendRequest('${uid}')" class="btn-sm" style="background:var(--accent);">申請</button>`);
        else if (rSnap.data().status === "accepted") {
            $actionBox.append(`<button onclick="openDM('${uid}','${escapeHTML(d.name || "ゲスト").replace(/'/g, "\\'")}')" class="btn-sm" style="background:var(--success);">DMを送る</button>`);
            $actionBox.append(`<span style="color:var(--friend-gold); font-size:12px; margin-left:10px;">★</span>`);
        }

        const isBlocked = myBlockedUsers.includes(uid);
        if (isBlocked) {
            $actionBox.append(`<button onclick="unblockUser('${uid}')" class="btn-sm" style="background:rgba(255,255,255,0.1); color:var(--txt-m); margin-left:6px;">🔓 ブロック解除</button>`);
        } else {
            $actionBox.append(`<button onclick="blockUser('${uid}')" class="btn-sm" style="background:rgba(255,77,77,0.15); color:#ff6b6b; margin-left:6px;">🚫 ブロック</button>`);
        }

        if (isCurrentUserAdmin) {
            $actionBox.append(`<button onclick="adminBanUser('${uid}', '${escapeHTML(d.name || "ゲスト").replace(/'/g, "\\'")}')" class="btn-sm" style="background:#7f1d1d; color:#fff; margin-left:6px;">⛔ BAN</button>`);
        }
    }
    $("#prof-modal").removeClass("hidden");
};

window.openDM = async (otherUid, otherName) => {
    const roomId = [auth.currentUser.uid, otherUid].sort().join("_");
    await setDoc(doc(db, "rooms", roomId), { users: [auth.currentUser.uid, otherUid] }, { merge: true });
    $("#prof-modal, #user-list-modal").addClass("hidden");
    toggleSidebar(false);
    switchChat(roomId, otherName, otherUid);
};

$("#my-profile-trigger").on("click", async () => {
    const snap = await getDoc(doc(db, "users", auth.currentUser.uid));
    if (snap.exists()) { 
        const d = snap.data(); 
        $("#editName").val(d.name); 
        $("#editPhoto").val(d.photo); 
        $("#editBanner").val(d.banner); 
        $("#editBio").val(d.bio);
        $("#editFavoriteSong").val(d.favoriteSong || '');
        renderSpotifyEmbed(d.favoriteSong || '', $("#editFavoriteSongPreview"));
        
        await loadEquipmentOptions(d);
    }
    syncProfilePreview(); 
    $("#settings-modal").removeClass("hidden");
});

async function loadEquipmentOptions(userData) {
    const ownedItems = userData.ownedItems || [];
    const equipped = userData.equipped || {};
    
    const $badgeSelect = $('#editEquippedBadge').empty();
    $badgeSelect.append('<option value="">なし</option>');
    if (ownedItems.includes('vip_badge')) $badgeSelect.append('<option value="vip_badge">👑 VIPバッジ</option>');
    if (ownedItems.includes('star_badge')) $badgeSelect.append('<option value="star_badge">⭐ スターバッジ</option>');
    if (ownedItems.includes('crown_badge')) $badgeSelect.append('<option value="crown_badge">👸 クラウンバッジ</option>');
    $badgeSelect.val(equipped.badge || '');
    
    const $themeSelect = $('#editEquippedTheme').empty();
    $themeSelect.append('<option value="">デフォルト</option>');
    if (ownedItems.includes('rainbow_theme')) $themeSelect.append('<option value="rainbow_theme">🌈 レインボーテーマ</option>');
    if (ownedItems.includes('heart_theme')) $themeSelect.append('<option value="heart_theme">💕 ハートテーマ</option>');
    $themeSelect.val(equipped.theme || '');
    
    const $effectSelect = $('#editEquippedEffect').empty();
    $effectSelect.append('<option value="">なし</option>');
    if (ownedItems.includes('fire_effect')) $effectSelect.append('<option value="fire_effect">🔥 炎エフェクト</option>');
    if (ownedItems.includes('sparkle_effect')) $effectSelect.append('<option value="sparkle_effect">✨ キラキラエフェクト</option>');
    if (ownedItems.includes('lightning_effect')) $effectSelect.append('<option value="lightning_effect">⚡ 稲妻エフェクト</option>');
    if (ownedItems.includes('rainbow_effect')) $effectSelect.append('<option value="rainbow_effect">🌟 虹色エフェクト</option>');
    if (ownedItems.includes('shadow_effect')) $effectSelect.append('<option value="shadow_effect">🌑 シャドウエフェクト</option>');
    if (ownedItems.includes('ice_effect')) $effectSelect.append('<option value="ice_effect">❄️ 氷エフェクト</option>');
    if (ownedItems.includes('toxic_effect')) $effectSelect.append('<option value="toxic_effect">☠️ 毒エフェクト</option>');
    if (ownedItems.includes('gold_effect')) $effectSelect.append('<option value="gold_effect">💛 ゴールドエフェクト</option>');
    $effectSelect.val(equipped.effect || '');
}

$("#saveProfile").on("click", async () => {
    const data = { 
        name: $("#editName").val(), 
        photo: $("#editPhoto").val(), 
        banner: $("#editBanner").val(), 
        bio: $("#editBio").val(),
        favoriteSong: $("#editFavoriteSong").val().trim(),
        equipped: {
            badge: $("#editEquippedBadge").val(),
            theme: $("#editEquippedTheme").val(),
            effect: $("#editEquippedEffect").val()
        }
    };
    await updateProfile(auth.currentUser, { displayName: data.name, photoURL: data.photo });
    await setDoc(doc(db, "users", auth.currentUser.uid), data, { merge: true });
    
    applyUserTheme();
    
    location.reload();
});

window.switchUserTab = (tab) => { 
    currentTab = tab; 
    $(".tab-btn").removeClass("active"); 
    if(tab === 'all') $(".tab-btn:contains('すべて')").addClass("active");
    else if(tab === 'friends') $(".tab-btn:contains('フレンド')").addClass("active");
    else if(tab === 'requests') {
        $(".tab-btn:contains('申請')").addClass("active");
        clearFriendRequestUnread();
        markFriendRequestsSeen();
    }
    loadUserList(); 
};

function clearFriendRequestUnread() {
    Object.keys(unreadRooms).forEach(key => {
        if(key.startsWith('friend_request_')) {
            delete unreadRooms[key];
        }
    });
    recalculateTotalUnread();
}

// フレンド申請の既読ラインをFirestoreに保存する。これにより、他の端末で開いた時や
// リロードした時に「もう見た申請」まで毎回通知されるのを防げる（端末間で既読状態を同期）。
async function markFriendRequestsSeen() {
    lastFriendReqSeenAtMs = Date.now();
    try {
        await setDoc(doc(db, "users", auth.currentUser.uid), {
            lastFriendReqSeenAt: serverTimestamp()
        }, { merge: true });
    } catch (error) {
        console.error('Mark friend requests seen error:', error);
    }
}
window.loadUserList = () => {
    onSnapshot(collection(db, "friendRequests"), (reqSnap) => {
        const reqMap = {}; 
        let pendingRequestCount = 0;
        
        reqSnap.forEach(d => {
            reqMap[d.id] = d.data();
            const data = d.data();
            if (data.to === auth.currentUser.uid && data.status === "pending") {
                pendingRequestCount++;
            }
        });
        
        const $badge = $("#request-count-badge");
        if (pendingRequestCount > 0) {
            $badge.text(pendingRequestCount).show();
        } else {
            $badge.hide();
        }
        
        onSnapshot(collection(db, "users"), (userSnap) => {
            const $list = $("#user-list-container").empty();
            
            if (currentTab === 'requests') {
                let hasRequests = false;
                
                $list.append('<div style="padding:10px; font-weight:bold; color:var(--txt-m); font-size:12px; border-bottom:1px solid var(--bg-38);">受信した申請</div>');
                Object.entries(reqMap).forEach(([reqId, reqData]) => {
                    if (reqData.to === auth.currentUser.uid && reqData.status === "pending") {
                        hasRequests = true;
                        const senderDoc = userSnap.docs.find(doc => doc.id === reqData.from);
                        if (senderDoc) {
                            const d = senderDoc.data();
                            const uid = senderDoc.id;
                            const safeName = escapeHTML(d.name || "ゲスト");
                            const isOnline = getUserOnlineStatus(uid) === 'online';
                            const isGuest = d.name === "ゲスト" || d.isAnonymous === true;
                            const guestLabel = isGuest ? '<span style="background:var(--bg-38); color:var(--txt-m); font-size:10px; padding:2px 6px; border-radius:3px; margin-left:5px;">ゲスト</span>' : '';
                            
                            $list.append(`<div class="user-item" data-uid="${uid}">
                                <div style="display:flex;align-items:center;gap:10px;cursor:pointer;" onclick="showProfile('${uid}')">
                                    <div class="icon-container">
                                        <img src="${d.photo || DEFAULT_AVATAR}" style="width:30px;height:30px;border-radius:50%">
                                        <div class="status-dot ${isOnline?'online':'offline'}"></div>
                                    </div>
                                    <span>${safeName}${guestLabel}</span>
                                </div>
                                <div>
                                    <button onclick="acceptRequest('${reqId}')" class="btn-sm" style="background:var(--success);">承認</button>
                                    <button onclick="removeFriend('${reqId}')" class="btn-sm" style="background:var(--danger); color:white;">拒否</button>
                                </div>
                            </div>`);
                        }
                    }
                });
                
                if (!hasRequests) {
                    $list.append('<div style="padding:20px; text-align:center; color:var(--txt-m); font-size:14px;">受信した申請はありません</div>');
                }
                
                $list.append('<div style="padding:10px; font-weight:bold; color:var(--txt-m); font-size:12px; border-bottom:1px solid var(--bg-38); margin-top:15px;">送信した申請</div>');
                let hasSentRequests = false;
                
                Object.entries(reqMap).forEach(([reqId, reqData]) => {
                    if (reqData.from === auth.currentUser.uid && reqData.status === "pending") {
                        hasSentRequests = true;
                        const targetDoc = userSnap.docs.find(doc => doc.id === reqData.to);
                        if (targetDoc) {
                            const d = targetDoc.data();
                            const uid = targetDoc.id;
                            const safeName = escapeHTML(d.name || "ゲスト");
                            const isOnline = getUserOnlineStatus(uid) === 'online';
                            
                            $list.append(`<div class="user-item" data-uid="${uid}">
                                <div style="display:flex;align-items:center;gap:10px;cursor:pointer;" onclick="showProfile('${uid}')">
                                    <div class="icon-container">
                                        <img src="${d.photo || DEFAULT_AVATAR}" style="width:30px;height:30px;border-radius:50%">
                                        <div class="status-dot ${isOnline?'online':'offline'}"></div>
                                    </div>
                                    <span>${safeName}</span>
                                </div>
                                <div>
                                    <span style="color:var(--txt-m); font-size:12px;">申請中</span>
                                    <button onclick="removeFriend('${reqId}')" class="btn-sm" style="background:var(--bg-2b); color:var(--danger); margin-left:5px;">取消</button>
                                </div>
                            </div>`);
                        }
                    }
                });
                
                if (!hasSentRequests) {
                    $list.append('<div style="padding:20px; text-align:center; color:var(--txt-m); font-size:14px;">送信した申請はありません</div>');
                }
                
                return;
            }
            
            userSnap.forEach((uDoc) => {
                const uid = uDoc.id; if (uid === auth.currentUser.uid) return;
                const d = uDoc.data();
                
                if (d.isAnonymous === true) return;
                if (d.name === "ゲスト") return;
                
                const isOnline = getUserOnlineStatus(uid) === 'online'; const reqId = [auth.currentUser.uid, uid].sort().join("_"); const req = reqMap[reqId];
                const safeName = escapeHTML(d.name || "ゲスト");
                let btn = `<button onclick="sendRequest('${uid}')" class="btn-sm" style="background:var(--accent);">申請</button>`;
                let isF = false;
                if (req) {
                    if (req.status === "accepted") { 
                        btn = `<button onclick="openDM('${uid}','${safeName.replace(/'/g, "\\'")}')" class="btn-sm" style="background:var(--success);">DM</button>`; 
                        btn += `<button onclick="removeFriend('${reqId}')" class="btn-sm" style="background:var(--bg-2b); color:var(--danger);">解除</button>`;
                        isF = true; 
                    }
                    else if (req.from === auth.currentUser.uid) btn = `<span style="color:var(--txt-m); font-size:12px;">申請中</span>`;
                    else btn = `<button onclick="acceptRequest('${reqId}')" class="btn-sm" style="background:var(--success);">承認</button>`;
                }
                if (currentTab === 'friends' && !isF) return;
                $list.append(`<div class="user-item" data-uid="${uid}"><div style="display:flex;align-items:center;gap:10px;cursor:pointer;" onclick="showProfile('${uid}')"><div class="icon-container"><img src="${d.photo || DEFAULT_AVATAR}" style="width:30px;height:30px;border-radius:50%"><div class="status-dot ${isOnline?'online':'offline'}"></div></div><span style="${isF?'color:var(--friend-gold);font-weight:bold;':''}">${safeName}</span></div><div>${btn}</div></div>`);
            });
        });
    });
};
window.sendRequest = async (uid) => { 
    if (auth.currentUser.isAnonymous || auth.currentUser.displayName === "ゲスト") {
        alert("フレンド機能を使うには、メールアドレスでログインしてください。\n\n右上のメニュー → ログアウト → メールでログイン");
        return;
    }
    const id = [auth.currentUser.uid, uid].sort().join("_"); 
    await setDoc(doc(db, "friendRequests", id), { from: auth.currentUser.uid, to: uid, status: "pending", createdAt: serverTimestamp() }); 
};
window.acceptRequest = async (id) => { await updateDoc(doc(db, "friendRequests", id), { status: "accepted" }); };
window.removeFriend = async (id) => { if (confirm("解除しますか？")) await deleteDoc(doc(db, "friendRequests", id)); };

// ===== 通話（WebRTC） =====
// このチャットではDM相手を指定した1対1通話のみサポートする（宛先の無い全体ブロードキャスト通話はしない）。
let callUnsubscribers = []; // 今の通話に関連するFirestore購読の解除関数をまとめて持つ

function stopCallListeners() {
    callUnsubscribers.forEach(unsub => { try { unsub(); } catch (e) {} });
    callUnsubscribers = [];
}

// カメラ/マイクの許可が得られなかった時に、ブラウザ設定への案内を出す
// （JSからブラウザの設定画面を直接開くことはできないため、手順を案内して再試行ボタンを出す）
function getPermissionHelpText() {
    const ua = navigator.userAgent;
    const isIOS = /iPhone|iPad|iPod/.test(ua);
    const isAndroid = /Android/.test(ua);

    if (isIOS) {
        return `iPhoneの「設定」アプリ →「Safari」→「カメラ」「マイク」の項目で「許可」または「確認」に変更してください。<br><br>
すでに許可している場合は、「設定」→「Safari」→「詳細」→「Webサイトの設定」から、このサイトの設定をリセットしてみてください。`;
    }
    if (isAndroid) {
        return `アドレスバー左側の🔒（鍵）またはアイコンをタップ →「サイトの設定」→「カメラ」「マイク」を「許可」に変更してください。`;
    }
    return `アドレスバー左側の🔒（鍵）アイコンをクリック →「カメラ」「マイク」の設定を「許可」に変更してください。変更後、ページの再読み込みが必要な場合があります。`;
}

function showPermissionHelp(onRetry) {
    $('#permission-help-text').html(getPermissionHelpText());
    $('#permission-help-modal').removeClass('hidden');
    $('#permissionRetryBtn').off('click').on('click', async () => {
        $('#permission-help-modal').addClass('hidden');
        if (onRetry) await onRetry();
    });
}

// getUserMediaの失敗理由に応じて出し分ける
function handleCallError(e, retryFn) {
    console.error('[call] エラー', e.name, e.message);
    if (e.name === 'NotAllowedError' || e.name === 'PermissionDeniedError' || e.name === 'SecurityError') {
        showPermissionHelp(retryFn);
    } else if (e.name === 'NotFoundError' || e.name === 'DevicesNotFoundError') {
        alert('カメラまたはマイクが見つかりませんでした。デバイスが接続されているか確認してください。');
    } else if (e.name === 'NotReadableError' || e.name === 'TrackStartError') {
        alert('カメラ/マイクが他のアプリで使用中の可能性があります。他のアプリを閉じてから再度お試しください。');
    } else {
        alert('通話の処理に失敗しました: ' + (e.message || e.name || '不明なエラー'));
    }
}

async function setupWebRTC() {
    pc = new RTCPeerConnection(servers);
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });

    // 通話開始時はマイク・カメラともにミュートにしておく（映る前に自分で確認してもらう）
    localStream.getAudioTracks().forEach(t => t.enabled = false);
    localStream.getVideoTracks().forEach(t => t.enabled = false);

    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    $("#localVideo")[0].srcObject = localStream;
    pc.ontrack = (e) => { $("#remoteVideo")[0].srcObject = e.streams[0]; };
    $("#call-overlay").removeClass("hidden");

    // サイズ表示を毎回「全画面」から開始する（前回の状態が残らないよう明示的にリセット）
    callSizeIndex = 0;
    $("#call-overlay")[0].setAttribute("data-size", "full");
    $("#call-overlay").css({ left: "", top: "", right: "", bottom: "" });
    $("#callResizeIcon").text("fullscreen_exit");

    // ミュート/カメラボタンをオフ状態の見た目にする
    $("#toggleMic").addClass("off").find(".material-symbols-outlined").text("mic_off");
    $("#toggleCam").addClass("off").find(".material-symbols-outlined").text("videocam_off");

    // カメラオフ中は自分の映像の代わりに名前とアイコンを出す
    $("#localVideoPlaceholderAvatar").attr("src", auth.currentUser.photoURL || DEFAULT_AVATAR);
    $("#localVideoPlaceholderName").text(auth.currentUser.displayName || "ゲスト");
    $("#localVideoPlaceholder").removeClass("hidden");
}

// 通話画面のサイズ切り替え（全画面 / 小窓 / 最小表示）
const CALL_SIZES = ['full', 'small', 'mini'];
const CALL_SIZE_ICONS = { full: 'fullscreen_exit', small: 'fit_screen', mini: 'fullscreen' };
let callSizeIndex = 0;
$('#callResizeBtn').on('click', () => {
    callSizeIndex = (callSizeIndex + 1) % CALL_SIZES.length;
    const size = CALL_SIZES[callSizeIndex];
    $('#call-overlay').attr('data-size', size);
    $('#callResizeIcon').text(CALL_SIZE_ICONS[size]);
    // ドラッグで動かした位置が残っていると次のサイズ表示が崩れるのでリセットする
    $('#call-overlay').css({ left: '', top: '', right: '', bottom: '' });
});

// 小窓・最小表示の時だけ、映像部分をホールドしてドラッグで動かせるようにする（PC・スマホ両対応）
(function() {
    const $overlay = $('#call-overlay');
    const $dragSurface = $('.yc-video-area');
    let dragging = false;
    let offsetX = 0, offsetY = 0;

    function isDraggableSize() {
        const size = $overlay.attr('data-size');
        return size === 'small' || size === 'mini';
    }

    function onDragStart(clientX, clientY) {
        if (!isDraggableSize()) return false;
        dragging = true;
        const rect = $overlay[0].getBoundingClientRect();
        offsetX = clientX - rect.left;
        offsetY = clientY - rect.top;
        $overlay.addClass('dragging');
        return true;
    }
    function onDragMove(clientX, clientY) {
        if (!dragging) return;
        const rect = $overlay[0].getBoundingClientRect();
        let left = clientX - offsetX;
        let top = clientY - offsetY;
        left = Math.max(4, Math.min(window.innerWidth - rect.width - 4, left));
        top = Math.max(4, Math.min(window.innerHeight - rect.height - 4, top));
        $overlay.css({ left: left + 'px', top: top + 'px', right: 'auto', bottom: 'auto' });
    }
    function onDragEnd() {
        dragging = false;
        $overlay.removeClass('dragging');
    }

    $dragSurface.on('pointerdown', (e) => {
        const ev = e.originalEvent || e;
        if (!onDragStart(ev.clientX, ev.clientY)) return;
        try { $dragSurface[0].setPointerCapture(ev.pointerId); } catch (err) {}
        e.preventDefault();
    });
    $dragSurface.on('pointermove', (e) => {
        if (!dragging) return;
        const ev = e.originalEvent || e;
        onDragMove(ev.clientX, ev.clientY);
    });
    $dragSurface.on('pointerup pointercancel', onDragEnd);
})();

// 発信者側: ICE candidateをFirestoreに書き出しつつ相手のanswer/candidateを待つ
async function startCallTo(targetUid, targetName) {
    try {
        await setupWebRTC();
        const callDoc = doc(collection(db, "calls"));
        currentCallId = callDoc.id;

        // answer(相手の応答)が確定する前にICE candidateが届くことがあるので、その間は一旦保留しておく
        let pendingIceCandidates = [];

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                addDoc(collection(db, "calls", currentCallId, "callerCandidates"), e.candidate.toJSON()).catch(() => {});
            }
        };

        const offer = await pc.createOffer();
        await pc.setLocalDescription(offer);

        await setDoc(callDoc, {
            callerUid: auth.currentUser.uid,
            targetUid: targetUid,
            caller: auth.currentUser.displayName || "ゲスト",
            offer: { type: offer.type, sdp: offer.sdp },
            createdAt: serverTimestamp(),
        });

        const unsubDoc = onSnapshot(callDoc, (s) => {
            const data = s.data();
            if (data?.answer && !pc.currentRemoteDescription) {
                pc.setRemoteDescription(new RTCSessionDescription(data.answer)).then(() => {
                    // 保留していたcandidateをまとめて追加する
                    pendingIceCandidates.forEach(c => {
                        pc.addIceCandidate(c).catch(err => console.error('[call] addIceCandidate失敗(保留分)', err));
                    });
                    pendingIceCandidates = [];
                }).catch(err => console.error('[call] setRemoteDescription失敗', err));
            }
            if (!s.exists()) {
                // 相手が切った、または自分で削除した
                endCall(false);
            }
        });
        const unsubCandidates = onSnapshot(collection(db, "calls", currentCallId, "calleeCandidates"), (snap) => {
            snap.docChanges().forEach(change => {
                if (change.type === "added") {
                    const candidate = new RTCIceCandidate(change.doc.data());
                    if (pc.remoteDescription) {
                        pc.addIceCandidate(candidate).catch(err => console.error('[call] addIceCandidate失敗', err));
                    } else {
                        pendingIceCandidates.push(candidate);
                    }
                }
            });
        });
        callUnsubscribers.push(unsubDoc, unsubCandidates);
    } catch (e) {
        await endCall(true); // 失敗時も必ず状態をリセットする
        handleCallError(e, () => startCallTo(targetUid, targetName));
    }
}

// 着信側: 自分宛のオファーを見つけたら応答する
let pendingIncomingCall = null; // { callId, offer, callerName }

function listenForCalls() {
    onSnapshot(collection(db, "calls"), (snap) => {
        snap.docChanges().forEach((change) => {
            if (change.type !== "added") return;
            const data = change.doc.data();
            // 自分宛（targetUid一致）で、まだ誰も応答していない着信だけ拾う
            if (!data.offer || data.answer || data.targetUid !== auth.currentUser.uid) return;
            // 古い（クリーンアップされずに残っていた）通話ドキュメントは無視する
            const createdMs = data.createdAt?.toMillis ? data.createdAt.toMillis() : 0;
            if (!createdMs || (Date.now() - createdMs) > 30000) return;
            if (currentCallId || pendingIncomingCall) return; // 既に通話中/着信中なら無視（多重着信防止）

            pendingIncomingCall = { callId: change.doc.id, offer: data.offer, callerName: data.caller || "ゲスト" };
            $("#incoming-call-name").text(pendingIncomingCall.callerName);
            $("#incoming-call-modal").removeClass("hidden");

            // 発信者が応答前に切った場合は着信ポップアップを自動で下げる
            const unsubRing = onSnapshot(change.doc.ref, (s) => {
                if (!s.exists() && pendingIncomingCall?.callId === change.doc.id) {
                    dismissIncomingCall();
                }
            });
            pendingIncomingCall.unsubRing = unsubRing;
        });
    });
}

function dismissIncomingCall() {
    if (pendingIncomingCall?.unsubRing) pendingIncomingCall.unsubRing();
    pendingIncomingCall = null;
    $("#incoming-call-modal").addClass("hidden");
}

// 「応答」ボタンが押された時だけカメラ/マイクを取得する（スマホはユーザー操作なしでのアクセスを許可しないため）
async function acceptIncomingCall(callId, offer) {
    currentCallId = callId;
    try {
        await setupWebRTC();

        pc.onicecandidate = (e) => {
            if (e.candidate) {
                addDoc(collection(db, "calls", currentCallId, "calleeCandidates"), e.candidate.toJSON()).catch(() => {});
            }
        };

        await pc.setRemoteDescription(new RTCSessionDescription(offer));
        const answer = await pc.createAnswer();
        await pc.setLocalDescription(answer);
        await updateDoc(doc(db, "calls", currentCallId), { answer: { type: answer.type, sdp: answer.sdp } });

        const callDocRef = doc(db, "calls", currentCallId);
        const unsubDoc = onSnapshot(callDocRef, (s) => {
            if (!s.exists()) endCall(false); // 相手が切った
        });
        const unsubCandidates = onSnapshot(collection(db, "calls", currentCallId, "callerCandidates"), (csnap) => {
            csnap.docChanges().forEach(c => {
                if (c.type === "added") {
                    const candidate = new RTCIceCandidate(c.doc.data());
                    if (pc.remoteDescription) {
                        pc.addIceCandidate(candidate).catch(err => console.error('[call] addIceCandidate失敗', err));
                    } else {
                        // この時点ではsetRemoteDescription済みのはずだが、念のため保険として保留する
                        setTimeout(() => pc.addIceCandidate(candidate).catch(err => console.error('[call] addIceCandidate失敗(遅延)', err)), 500);
                    }
                }
            });
        });
        callUnsubscribers.push(unsubDoc, unsubCandidates);
    } catch (e) {
        await endCall(true); // 失敗時も必ず状態をリセットする（currentCallIdが固まって「通話中」から抜けられなくなるのを防ぐ）
        handleCallError(e, () => acceptIncomingCall(callId, offer));
    }
}

$("#acceptCallBtn").on("click", async () => {
    if (!pendingIncomingCall) return;
    const { callId, offer } = pendingIncomingCall;
    if (pendingIncomingCall.unsubRing) pendingIncomingCall.unsubRing();
    pendingIncomingCall = null;
    $("#incoming-call-modal").addClass("hidden");

    await acceptIncomingCall(callId, offer);
});

$("#declineCallBtn").on("click", async () => {
    if (!pendingIncomingCall) return;
    const { callId } = pendingIncomingCall;
    dismissIncomingCall();
    // 拒否したことを発信者に伝えるため、ドキュメント自体を削除する
    try {
        await deleteDoc(doc(db, "calls", callId));
    } catch (e) {}
});

// 通話終了（自分から切る場合はFirestoreの通話ドキュメントも削除して相手に伝える）
async function endCall(deleteRemote = true) {
    stopCallListeners();
    dismissIncomingCall(); // 着信ポップアップが出ていた場合も一緒に消す

    if (pc) {
        pc.close();
        pc = null;
    }
    if (localStream) {
        localStream.getTracks().forEach(t => t.stop());
        localStream = null;
    }
    $("#localVideo, #remoteVideo").each(function() { this.srcObject = null; });
    $("#localVideoPlaceholder").addClass("hidden");
    $("#call-overlay").addClass("hidden").attr("data-size", "full");
    callSizeIndex = 0;
    $("#callResizeIcon").text("fullscreen_exit");

    const callIdToClean = currentCallId;
    currentCallId = null;

    if (deleteRemote && callIdToClean) {
        try {
            const [callerCands, calleeCands] = await Promise.all([
                getDocs(collection(db, "calls", callIdToClean, "callerCandidates")),
                getDocs(collection(db, "calls", callIdToClean, "calleeCandidates")),
            ]);
            await Promise.all([
                ...callerCands.docs.map(d => deleteDoc(d.ref)),
                ...calleeCands.docs.map(d => deleteDoc(d.ref)),
            ]);
            await deleteDoc(doc(db, "calls", callIdToClean));
        } catch (e) {
            console.error('[call] 通話ドキュメントの削除に失敗', e);
        }
    }
}

$("#hangupBtn").on("click", () => endCall(true));

$("#toggleMic").on("click", function() {
    if (!localStream) return;
    const audioTrack = localStream.getAudioTracks()[0];
    if (!audioTrack) return;
    audioTrack.enabled = !audioTrack.enabled;
    $(this).toggleClass("off", !audioTrack.enabled)
        .find(".material-symbols-outlined").text(audioTrack.enabled ? "mic" : "mic_off");
});

$("#toggleCam").on("click", function() {
    if (!localStream) return;
    const videoTrack = localStream.getVideoTracks()[0];
    if (!videoTrack) return;
    videoTrack.enabled = !videoTrack.enabled;
    $(this).toggleClass("off", !videoTrack.enabled)
        .find(".material-symbols-outlined").text(videoTrack.enabled ? "videocam" : "videocam_off");
    // カメラオフ中は映像の代わりに名前とアイコンを出す
    $("#localVideoPlaceholder").toggleClass("hidden", videoTrack.enabled);
});

// ===== Realtime Database プレゼンス管理（RTDBのみ、Firestore書き込みなし） =====
let statusCache = {}; // { uid: 'online' | 'offline' }
let presenceUid = null;       // 現在プレゼンスを設定しているuid
let unsubConnected = null;    // .info/connected の購読解除用
let statusListenerStarted = false;

function markUserOffline(uid) {
    if (!uid) return;
    rtdbSet(rtdbRef(rtdb, `status/${uid}`), {
        state: 'offline',
        lastSeen: rtdbServerTimestamp()
    }).catch(() => {});
}

// ログアウト（自動ログアウトも含む）でユーザーがいなくなった時に呼ぶ
function clearPresenceOnSignedOut() {
    markUserOffline(presenceUid);
    presenceUid = null;
    if (unsubConnected) {
        unsubConnected();
        unsubConnected = null;
    }
}

const initPresence = (uid) => {
    if (presenceUid === uid) return; // 既に同じユーザーで設定済み

    // 別ユーザーに切り替わる場合は、前のユーザーを明示的にオフラインにしておく
    if (presenceUid && presenceUid !== uid) {
        markUserOffline(presenceUid);
    }
    if (unsubConnected) {
        unsubConnected();
        unsubConnected = null;
    }

    presenceUid = uid;

    const myStatusRef  = rtdbRef(rtdb, `status/${uid}`);
    const connectedRef = rtdbRef(rtdb, '.info/connected');

    unsubConnected = onValue(connectedRef, (snap) => {
        if (snap.val() === false) return; // 切断中は何もしない
        if (presenceUid !== uid) return;  // その間に別ユーザーへ切り替わっていたら無視

        // ① 切断時にサーバー側で自動的にofflineにする設定を先に仕込む
        onDisconnect(myStatusRef).set({
            state: 'offline',
            lastSeen: rtdbServerTimestamp()
        }).then(() => {
            if (presenceUid !== uid) return;
            // ② 仕込み完了後にonlineをセット
            rtdbSet(myStatusRef, {
                state: 'online',
                lastSeen: rtdbServerTimestamp()
            });
        });
    });

    // 全ユーザーのステータス購読は一度だけ張ればよい
    if (!statusListenerStarted) {
        statusListenerStarted = true;
        onValue(rtdbRef(rtdb, 'status'), (snap) => {
            const data = snap.val() || {};
            Object.keys(data).forEach(u => {
                statusCache[u] = data[u]?.state || 'offline';
            });
            updateAllStatusDots();
        });
    }
};

function updateAllStatusDots() {
    Object.keys(statusCache).forEach(uid => {
        const cls = statusCache[uid] === 'online' ? 'online' : 'offline';
        $(`.message[data-uid="${uid}"] .status-dot`).removeClass('online offline').addClass(cls);
        $(`.sidebar-item[data-user-id="${uid}"] .status-dot`).removeClass('online offline').addClass(cls);
        $(`.user-item[data-uid="${uid}"] .status-dot`).removeClass('online offline').addClass(cls);
    });
}

// 個別ユーザーのオンライン状態を取得するヘルパー
function getUserOnlineStatus(uid) {
    return statusCache[uid] === 'online' ? 'online' : 'offline';
}

// ===== 認証タブ切り替え =====
window.switchAuthTab = (tab) => {
    $('#authFormLogin, #authFormRegister, #authFormVerify').hide();
    $('#authTabLogin, #authTabRegister').css({ background: 'transparent', color: 'var(--txt-m)' });
    if (tab === 'login') {
        $('#authFormLogin').show();
        $('#authTabLogin').css({ background: 'var(--accent)', color: '#fff' });
    } else if (tab === 'register') {
        $('#authFormRegister').show();
        $('#authTabRegister').css({ background: 'var(--accent)', color: '#fff' });
    } else if (tab === 'verify') {
        $('#authFormVerify').show();
    }
};

// ===== ログイン =====
$("#loginBtn").on("click", async () => {
    const e = $("#loginEmail").val().trim();
    const p = $("#loginPassword").val();
    $('#loginError').hide();
    if (!e || !p) { $('#loginError').text('メールとパスワードを入力してください').show(); return; }
    try {
        const cred = await signInWithEmailAndPassword(auth, e, p);

        // サインイン直後のcred.user.emailVerifiedも、状況によっては古い情報のままなことがあるため、
        // 判定前に必ずreload()でサーバーの最新状態を取得し直す（onAuthStateChanged側と同じ対応）。
        try { await reload(cred.user); } catch (reloadErr) { console.error('[auth] ログイン時reload失敗', reloadErr); }

        if (!cred.user.emailVerified) {
            await sendEmailVerification(cred.user);
            await signOut(auth);
            $('#loginError').html('メールアドレスが認証されていません。<br>認証メールを送信しました。届いたメールのリンクをクリックしてからログインしてください。').show();
            return;
        }
        location.reload();
    } catch (err) {
        const msg = err.code === 'auth/user-not-found' || err.code === 'auth/wrong-password' || err.code === 'auth/invalid-credential'
            ? 'メールアドレスまたはパスワードが正しくありません'
            : 'ログインエラー: ' + err.message;
        $('#loginError').text(msg).show();
    }
});

// ===== 新規登録 =====
$("#registerBtn").on("click", async () => {
    const name = $("#registerName").val().trim();
    const e    = $("#registerEmail").val().trim();
    const p    = $("#registerPassword").val();
    const p2   = $("#registerPasswordConfirm").val();
    $('#registerError').hide();
    if (!name) { $('#registerError').text('ユーザー名を入力してください').show(); return; }
    if (!e)    { $('#registerError').text('メールアドレスを入力してください').show(); return; }
    if (p.length < 6) { $('#registerError').text('パスワードは6文字以上にしてください').show(); return; }
    if (p !== p2)     { $('#registerError').text('パスワードが一致しません').show(); return; }
    try {
        const res = await createUserWithEmailAndPassword(auth, e, p);
        await updateProfile(res.user, { displayName: name });
        await setDoc(doc(db, "users", res.user.uid), {
            name, photo: DEFAULT_AVATAR, isTyping: false, isAnonymous: false
        });
        await sendEmailVerification(res.user);
        await signOut(auth);
        $('#verifyEmailAddr').text(e);
        switchAuthTab('verify');
    } catch (err) {
        const msg = err.code === 'auth/email-already-in-use'
            ? 'このメールアドレスは既に使われています'
            : '登録エラー: ' + err.message;
        $('#registerError').text(msg).show();
    }
});

// ===== 認証確認 =====
$("#verifyCheckBtn").on("click", async () => {
    const e = $("#registerEmail").val().trim() || $("#loginEmail").val().trim();
    const p = $("#registerPassword").val() || $("#loginPassword").val();
    try {
        const cred = await signInWithEmailAndPassword(auth, e, p);
        await reload(cred.user);
        if (cred.user.emailVerified) {
            location.reload();
        } else {
            alert('まだ認証されていません。メール内のリンクをクリックしてください。');
            await signOut(auth);
        }
    } catch (err) {
        alert('確認エラー: ' + err.message);
    }
});

// ===== 認証メール再送 =====
$("#resendVerifyBtn").on("click", async () => {
    const e = $("#registerEmail").val().trim();
    const p = $("#registerPassword").val();
    try {
        const cred = await signInWithEmailAndPassword(auth, e, p);
        await sendEmailVerification(cred.user);
        await signOut(auth);
        alert('確認メールを再送しました。');
    } catch (err) {
        alert('再送エラー: ' + err.message);
    }
});

// ===== パスワードリセット =====
$("#forgotPasswordBtn").on("click", async () => {
    const e = $("#loginEmail").val().trim();
    if (!e) { $('#loginError').text('メールアドレスを入力してからパスワードを再設定してください').show(); return; }
    try {
        await sendPasswordResetEmail(auth, e);
        alert(`${e} にパスワード再設定メールを送信しました。`);
    } catch (err) {
        const msg = err.code === 'auth/user-not-found'
            ? 'このメールアドレスは登録されていません'
            : 'エラー: ' + err.message;
        $('#loginError').text(msg).show();
    }
});

// ===== ゲストログイン =====
$("#guestBtn").on("click", async () => {
    try { await signInAnonymously(auth); location.reload(); }
    catch (e) { alert("ゲストログインエラー: " + e.message); }
});

const doLogout = async () => { 
    if (auth.currentUser) {
        try {
            await rtdbSet(rtdbRef(rtdb, `status/${auth.currentUser.uid}`), {
                state: 'offline',
                lastSeen: rtdbServerTimestamp()
            });
        } catch (e) {}
    }
    signOut(auth).then(() => location.reload()); 
};

$("#logoutBtn, #logoutBtnSide").on("click", doLogout);

// ===== 設定ドロワー（右からスライド） =====
window.toggleSettingsDrawer = (show) => {
    if (show) {
        $("#other-settings-modal").addClass("open");
        $("#settings-drawer-overlay").fadeIn(200);
        initNotifUI();
        updateAccountStatusUI();
        $('#ytDefaultPref').val(getYtPref());
    } else {
        $("#other-settings-modal").removeClass("open");
        $("#settings-drawer-overlay").fadeOut(200);
    }
};
$("#settings-drawer-overlay").on("click", () => toggleSettingsDrawer(false));
$('#ytDefaultPref').on('change', function() { setYtPref($(this).val()); });

// ===== アカウント状態表示 =====
function updateAccountStatusUI() {
    const user = auth.currentUser;
    if (!user) return;

    const isAnon = user.isAnonymous;
    const hasEmail = !!user.email;
    const isVerified = user.emailVerified;

    if (isAnon) {
        $('#account-status-area').html(`
            <div style="color:#ffd700; margin-bottom:4px;">👤 ゲスト（匿名）</div>
            <div style="font-size:12px;">メールアドレスを追加するとアカウントが保護されます。</div>
        `);
        $('#add-email-section').show();
        $('#verify-email-section').hide();
    } else if (hasEmail && !isVerified) {
        $('#account-status-area').html(`
            <div style="color:#ff4757; margin-bottom:4px;">⚠️ メール未認証</div>
            <div style="font-size:12px;">${user.email}</div>
        `);
        $('#verify-email-section').show();
        $('#add-email-section').hide();
    } else if (hasEmail && isVerified) {
        $('#account-status-area').html(`
            <div style="color:#00c853; margin-bottom:4px;">✅ 認証済み</div>
            <div style="font-size:12px;">${user.email}</div>
        `);
        $('#verify-email-section').hide();
        $('#add-email-section').hide();
    }
}

// ===== 認証メール送信（設定から） =====
$('#sendVerifyEmailBtn').on('click', async () => {
    try {
        await sendEmailVerification(auth.currentUser);
        alert('認証メールを送信しました。メール内のリンクをクリックしてください。');
    } catch (err) {
        alert('送信エラー: ' + err.message);
    }
});

// ===== ゲストにメールアドレス追加 =====
$('#addEmailBtn').on('click', async () => {
    const email = $('#addEmail').val().trim();
    const password = $('#addPassword').val();
    $('#addEmailError').hide();
    if (!email) { $('#addEmailError').text('メールアドレスを入力してください').show(); return; }
    if (password.length < 6) { $('#addEmailError').text('パスワードは6文字以上にしてください').show(); return; }
    try {
        const credential = EmailAuthProvider.credential(email, password);
        await linkWithCredential(auth.currentUser, credential);
        await sendEmailVerification(auth.currentUser);
        await updateDoc(doc(db, "users", auth.currentUser.uid), { isAnonymous: false });
        alert('メールアドレスを追加しました。確認メールが届きますので認証してください。');
        updateAccountStatusUI();
    } catch (err) {
        const msg = err.code === 'auth/email-already-in-use'
            ? 'このメールアドレスは既に使われています'
            : err.code === 'auth/invalid-email'
            ? 'メールアドレスの形式が正しくありません'
            : 'エラー: ' + err.message;
        $('#addEmailError').text(msg).show();
    }
});

// --- イベント監視 ---

// タブ表示/非表示: 未読クリアのみ（オンライン判定はRTDBのonDisconnect/接続状態が自動処理する）
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible") {
        clearUnread();
    } else {
        updateTypingStatus(false); // タブを離れたら「入力中」を確実に解除する
    }
}, true);

window.addEventListener("focus", () => {
    clearUnread();
});

// ユーザーアクションで未読クリア（オンライン状態のFirestore書き込みは行わない）
window.addEventListener("mousemove", () => { if (document.hasFocus()) clearUnread(); });
window.addEventListener("click", () => { clearUnread(); });
window.addEventListener("keydown", () => { clearUnread(); });

let lastTouchTime = 0;
window.addEventListener("touchstart", () => {
    const now = Date.now();
    if (now - lastTouchTime > 100) { clearUnread(); lastTouchTime = now; }
}, { passive: true });

// ============================================================
// スマホ長押しコンテキストメニュー
// ============================================================
(function() {
    const menuEl = document.createElement('div');
    menuEl.id = 'msg-context-menu';
    menuEl.classList.add('hidden');
    document.body.appendChild(menuEl);

    const overlayEl = document.createElement('div');
    overlayEl.id = 'msg-context-menu-overlay';
    overlayEl.classList.add('hidden');
    document.body.appendChild(overlayEl);

    let pressTimer = null;
    let targetMsg = null;

    function isMobile() {
        return window.matchMedia('(max-width: 600px)').matches;
    }

    function closeMenu() {
        menuEl.classList.add('hidden');
        overlayEl.classList.add('hidden');
        targetMsg = null;
    }

    overlayEl.addEventListener('click', closeMenu);
    overlayEl.addEventListener('touchend', closeMenu);

    function showMenu(msgEl, x, y) {
        const id      = msgEl.dataset.msgid;
        const isMe    = msgEl.dataset.isMe === 'true';
        const isStamp = msgEl.dataset.isStamp === 'true';
        const name    = msgEl.dataset.name || '';
        const text    = msgEl.dataset.text || '';

        let items = [];

        items.push(`<div class="ctx-item" data-action="reaction">
            <span class="material-symbols-outlined">add_reaction</span> リアクション
        </div>`);

        if (!isStamp && text) {
            items.push(`<div class="ctx-item" data-action="copy">
                <span class="material-symbols-outlined">content_copy</span> コピー
            </div>`);
        }

        const replyLabel = isStamp ? 'スタンプ' : (text || '画像');
        items.push(`<div class="ctx-item" data-action="reply" data-id="${id}" data-name="${name}" data-text="${replyLabel}">
            <span class="material-symbols-outlined">reply</span> 返信
        </div>`);

        if (isMe && !isStamp) {
            items.push(`<div class="ctx-item" data-action="edit" data-id="${id}" data-text="${text}">
                <span class="material-symbols-outlined">edit</span> 編集
            </div>`);
        }

        if (isMe) {
            items.push(`<div class="ctx-item danger" data-action="delete" data-id="${id}">
                <span class="material-symbols-outlined">delete</span> 削除
            </div>`);
        }

        menuEl.innerHTML = items.join('');
        menuEl.classList.remove('hidden');
        overlayEl.classList.remove('hidden');

        const menuW = 200;
        const menuH = items.length * 46;
        const vw = window.innerWidth;
        const vh = window.innerHeight;
        let px = x;
        let py = y;
        if (px + menuW > vw) px = vw - menuW - 10;
        if (py + menuH > vh) py = vh - menuH - 10;
        if (py < 10) py = 10;
        menuEl.style.left = px + 'px';
        menuEl.style.top  = py + 'px';

        menuEl.querySelectorAll('.ctx-item').forEach(item => {
            item.addEventListener('click', function(ev) {
                ev.stopPropagation(); // documentのクリック監視でリアクションピッカーが即閉じてしまうのを防ぐ
                const action = this.dataset.action;
                const _id   = this.dataset.id || id;
                if (action === 'reaction') {
                    const fakeEvent = { clientX: px, clientY: py, target: menuEl, stopPropagation: () => {} };
                    const existingReactions = {};
                    msgEl.querySelectorAll('.reaction-badge').forEach(b => {
                        const parts = b.textContent.trim().split(' ');
                        if (parts.length === 2) existingReactions[parts[0]] = [];
                    });
                    if (typeof window.openReactionPicker === 'function') {
                        window.openReactionPicker(id, fakeEvent, existingReactions);
                    }
                } else if (action === 'copy') {
                    if (navigator.clipboard && navigator.clipboard.writeText) {
                        navigator.clipboard.writeText(text).catch(() => {});
                    } else {
                        // クリップボードAPIが使えない環境向けのフォールバック
                        const ta = document.createElement('textarea');
                        ta.value = text;
                        ta.style.position = 'fixed';
                        ta.style.opacity = '0';
                        document.body.appendChild(ta);
                        ta.select();
                        try { document.execCommand('copy'); } catch (e) {}
                        ta.remove();
                    }
                } else if (action === 'reply') {
                    if (typeof window.setReply === 'function') window.setReply(_id, name, replyLabel);
                } else if (action === 'edit') {
                    if (typeof window.setEdit === 'function') window.setEdit(_id, text);
                } else if (action === 'delete') {
                    if (typeof window.deleteMsg === 'function') window.deleteMsg(_id);
                }
                closeMenu();
            });
        });
    }

    document.addEventListener('touchstart', function(e) {
        if (!isMobile()) return;
        const msgEl = e.target.closest('.message');
        if (!msgEl) return;
        if (e.target.closest('.icon-container, .op-btn, .reaction-badge, .reply-in-bubble, .sent-img, .sent-img-wrap, .stamp-display')) return;

        targetMsg = msgEl;
        pressTimer = setTimeout(() => {
            if (targetMsg) {
                if (navigator.vibrate) navigator.vibrate(30);
                const touch = e.touches[0];
                showMenu(msgEl, touch.clientX, touch.clientY);
            }
        }, 500);
    }, { passive: true });

    document.addEventListener('touchend', function() {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    }, { passive: true });

    document.addEventListener('touchmove', function() {
        if (pressTimer) { clearTimeout(pressTimer); pressTimer = null; }
    }, { passive: true });

    // PC: 右クリックでブラウザ標準メニューの代わりに同じメニューを出す
    document.addEventListener('contextmenu', function(e) {
        if (isMobile()) return; // スマホは長押しメニューのみ
        const msgEl = e.target.closest('.message');
        if (!msgEl) return;
        if (e.target.closest('.icon-container, .op-btn, .reaction-badge, .reply-in-bubble, .sent-img, .sent-img-wrap, .stamp-display')) return;

        e.preventDefault();
        targetMsg = msgEl;
        showMenu(msgEl, e.clientX, e.clientY);
    });
})();

// ============================================================
// 通話ボタン（DM中のみ表示）
// ============================================================
$('#callDMBtn').on('click', async () => {
    if (!currentDMOtherUid) return;
    if (currentCallId) { alert('すでに通話中です'); return; }
    toggleSettingsDrawer(false);
    await startCallTo(currentDMOtherUid);
});

// ============================================================
// ランキング
// ============================================================
window.openRankingFromMenu = () => {
    $('#ranking-modal').removeClass('hidden');
    loadRanking();
};

async function loadRanking() {
    const $list = $('#ranking-list').html('<div style="text-align:center; padding:20px; color:var(--txt-m);">読み込み中...</div>');
    try {
        const snap = await getDocs(collection(db, "users"));
        let users = snap.docs.map(d => ({ uid: d.id, ...d.data() })).filter(u => u.name);
        users.sort((a, b) => (b.coins || 0) - (a.coins || 0));

        const medals = ['🥇', '🥈', '🥉'];
        $list.empty();
        users.slice(0, 20).forEach((u, i) => {
            const rank = i < 3 ? medals[i] : `${i + 1}`;
            const value = `💰 ${(u.coins || 0).toLocaleString()}`;
            const isMe = auth.currentUser && u.uid === auth.currentUser.uid;
            $list.append(`
                <div style="display:flex; align-items:center; gap:12px; padding:10px 12px; border-radius:8px; margin-bottom:6px; background:${isMe ? 'rgba(88,101,242,0.15)' : 'var(--bg-38)'}; border:${isMe ? '1px solid var(--accent)' : '1px solid transparent'};">
                    <div style="width:28px; text-align:center; font-size:18px; font-weight:bold;">${rank}</div>
                    <img src="${u.photo || 'https://via.placeholder.com/30'}" style="width:32px; height:32px; border-radius:50%; object-fit:cover;">
                    <div style="flex:1; min-width:0;">
                        <div style="font-weight:bold; font-size:14px; white-space:nowrap; overflow:hidden; text-overflow:ellipsis;">${escapeHTML(u.name)}</div>
                    </div>
                    <div style="font-size:13px; font-weight:bold; color:#ffd700; white-space:nowrap;">${value}</div>
                </div>
            `);
        });
        if (users.length === 0) $list.html('<div style="text-align:center; padding:20px; color:var(--txt-m);">まだデータがありません</div>');
    } catch(e) {
        $list.html('<div style="text-align:center; padding:20px; color:var(--danger);">読み込みエラー</div>');
    }
}