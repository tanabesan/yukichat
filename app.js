import { initializeApp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-app.js";
import { initializeFirestore, persistentLocalCache, persistentMultipleTabManager, collection, addDoc, serverTimestamp, query, orderBy, limit, onSnapshot, doc, getDoc, getDocs, setDoc, updateDoc, arrayUnion, arrayRemove, deleteDoc, startAfter, where } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-firestore.js";
import { getAuth, onAuthStateChanged, signInWithEmailAndPassword, createUserWithEmailAndPassword, updateProfile, signOut, signInAnonymously } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-auth.js";
import { getDatabase, ref as rtdbRef, set as rtdbSet, onValue, onDisconnect, serverTimestamp as rtdbServerTimestamp } from "https://www.gstatic.com/firebasejs/10.8.0/firebase-database.js";

const firebaseConfig = { apiKey: "AIzaSyA8X7HsOXDERBTy4GvLE8ibg3bk8JhldZg", authDomain: "chat-16746.firebaseapp.com", projectId: "chat-16746", storageBucket: "chat-16746.firebasestorage.app", messagingSenderId: "1009009975164", appId: "1:1009009975164:web:64192371271cb589614ef9" };
const app = initializeApp(firebaseConfig);
const rtdb = getDatabase(app);

const db = initializeFirestore(app, {
    localCache: persistentLocalCache({tabManager: persistentMultipleTabManager()})
});
const auth = getAuth(app);

// --- 通知音と設定用変数 ---
// ===== サウンドエンジン (Web Audio API) =====
const _audioCtx = new (window.AudioContext || window.webkitAudioContext)();

function _resumeCtx() {
    if (_audioCtx.state === 'suspended') _audioCtx.resume();
}

// 基本音生成ユーティリティ
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

// ノイズ生成（スロット回転音用）
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

// --- 各効果音 ---

// 通知音: ポコン♪（チャット受信）
function playNotifySound() {
    if (!isSoundEnabled) return;
    _resumeCtx();
    const t = _audioCtx.currentTime;
    _tone(880,  t,       0.10, 0.3, 'sine');
    _tone(1320, t+0.11,  0.10, 0.25, 'sine');
}

// スロット回転音（ガラガラ）
function playSlotSpinSound(duration) {
    if (!isSoundEnabled) return;
    _resumeCtx();
    const t = _audioCtx.currentTime;
    _noise(t, duration * 0.001, 0.2);
    // カタカタ音
    for (let i = 0; i < 6; i++) {
        _tone(200 + Math.random()*100, t + i * duration * 0.00015, 0.04, 0.08, 'square');
    }
}

// リール停止音（コトン）
function playReelStopSound(reelIndex) {
    if (!isSoundEnabled) return;
    _resumeCtx();
    const t = _audioCtx.currentTime;
    const freq = [300, 340, 380][reelIndex] || 300;
    _tone(freq, t, 0.08, 0.35, 'triangle');
    _tone(freq * 0.5, t, 0.12, 0.2, 'sine');
}

// リーチ音（ドキドキ）
function playReachSound() {
    if (!isSoundEnabled) return;
    _resumeCtx();
    const t = _audioCtx.currentTime;
    _tone(440, t,      0.08, 0.3, 'square');
    _tone(440, t+0.12, 0.08, 0.3, 'square');
    _tone(440, t+0.24, 0.08, 0.3, 'square');
    _tone(660, t+0.40, 0.15, 0.4, 'square');
}

// 当たり音（コイン）
function playWinSound() {
    if (!isSoundEnabled) return;
    _resumeCtx();
    const t = _audioCtx.currentTime;
    [523, 659, 784, 1047].forEach((f, i) => {
        _tone(f, t + i * 0.08, 0.15, 0.3, 'sine');
    });
}

// 大当たり音（ジャックポット）
function playJackpotSound() {
    if (!isSoundEnabled) return;
    _resumeCtx();
    const t = _audioCtx.currentTime;
    // ファンファーレ
    [523, 659, 784, 1047, 1319, 1568].forEach((f, i) => {
        _tone(f, t + i * 0.07, 0.18, 0.35, 'sine');
    });
    // コイン音を重ねる
    for (let i = 0; i < 8; i++) {
        _tone(1200 + Math.random()*400, t + 0.5 + i*0.06, 0.06, 0.15, 'triangle');
    }
}

// 外れ音（ブー）
function playMissSound() {
    if (!isSoundEnabled) return;
    _resumeCtx();
    const t = _audioCtx.currentTime;
    _tone(220, t,      0.15, 0.3, 'sawtooth');
    _tone(180, t+0.18, 0.20, 0.3, 'sawtooth');
}

// BOOSTED発動音
function playBoostedSound() {
    if (!isSoundEnabled) return;
    _resumeCtx();
    const t = _audioCtx.currentTime;
    [300, 400, 500, 700, 900].forEach((f, i) => {
        _tone(f, t + i * 0.06, 0.12, 0.3, 'square');
    });
}

// 後方互換: notifyAudio.play()を呼んでる箇所に対応
const notifyAudio = { play: () => { playNotifySound(); return Promise.resolve(); }, currentTime: 0, volume: 0.5 };

let unreadCount = 0;
let unreadRooms = {}; // 各DM部屋の未読数を管理
let lastSeenTimestamps = {}; // 各チャットの最終閲覧時刻
let isSoundEnabled = localStorage.getItem("chat_sound_enabled") !== "false"; 

function updateSoundBtnUI() {
    if(isSoundEnabled) {
        $("#toggleSoundBtn").removeClass("btn-toggle-off").addClass("btn-toggle-on");
        $("#toggleSoundBtn span:first").text("volume_up");
        $("#soundBtnText").text("通知音: ON");
    } else {
        $("#toggleSoundBtn").removeClass("btn-toggle-on").addClass("btn-toggle-off");
        $("#toggleSoundBtn span:first").text("volume_off");
        $("#soundBtnText").text("通知音: OFF");
    }
}
updateSoundBtnUI();

$("#toggleSoundBtn").on("click", () => {
    isSoundEnabled = !isSoundEnabled;
    localStorage.setItem("chat_sound_enabled", isSoundEnabled);
    updateSoundBtnUI();
    if(isSoundEnabled) notifyAudio.play().catch(e=>console.log(e));
});

function clearUnread() {
    // 現在のチャットの最終閲覧時刻を記録
    const readKey = currentRoomId || "global";
    lastSeenTimestamps[readKey] = Date.now();
    localStorage.setItem('chat_last_seen_' + readKey, lastSeenTimestamps[readKey].toString());
    
    // このチャットの未読をクリア
    if(unreadRooms[readKey]) {
        delete unreadRooms[readKey];
        updateDMBadges();
    }
    
    // 全体の未読数を再計算
    recalculateTotalUnread();
    
    console.log("Cleared unread for:", readKey, "Total unread:", unreadCount);
}

// 全体の未読数を再計算してバッジを更新
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

// DMバッジを更新する関数
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

const STAMP_LIST = [
    "https://fonts.gstatic.com/s/e/notoemoji/latest/1f600/512.webp",
    "https://fonts.gstatic.com/s/e/notoemoji/latest/1f60d/512.webp",
    "https://fonts.gstatic.com/s/e/notoemoji/latest/1f62d/512.webp",
    "https://fonts.gstatic.com/s/e/notoemoji/latest/1f602/512.webp",
    "https://fonts.gstatic.com/s/e/notoemoji/latest/1f44d/512.webp",
    "https://fonts.gstatic.com/s/e/notoemoji/latest/1f525/512.webp",
    "https://fonts.gstatic.com/s/e/notoemoji/latest/1f389/512.webp",
    "https://fonts.gstatic.com/s/e/notoemoji/latest/1f4af/512.webp"
];

let pendingImageUrl = null, replyTarget = null, editTargetId = null, pc, localStream, currentCallId = null;
let currentRoomId = null;
let currentDMOtherUid = null; // DM相手のuid
let currentUnsubscribe = null;
let globalUnsubscribers = [];
let friendIds = [];
const servers = { iceServers: [{ urls: ['stun:stun1.l.google.com:19302', 'stun:stun2.l.google.com:19302'] }] };
let currentTab = 'all', usersCache = {}, isInitialLoad = true, lastMsgCount = 0;
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
    } else {
        $("#sidebar").removeClass("open");
        $("#sidebar-overlay").fadeOut(200);
    }
};
$("#menuToggle, #sidebar-overlay").on("click", () => toggleSidebar(!$("#sidebar").hasClass("open")));

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
        const statusClass = u.status === 'online' ? 'online' : 'offline';
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
        // rAF2回で確実にDOM確定後にスクロール
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
    
    if (user) {
        // ページロード時に既読状態を復元
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
        console.log("Restored last seen timestamps:", lastSeenTimestamps);
        
        if (user.isAnonymous) {
            const exp = new Date(); 
            exp.setDate(exp.getDate() + 30);
            
            const uRef = doc(db, "users", user.uid);
            const s = await getDoc(uRef);
            if(!s.exists()) {
                await setDoc(uRef, { name: "ゲスト", photo: DEFAULT_AVATAR, status: "online", isTyping: false, expireAt: exp, isAnonymous: true });
            } else {
                await updateDoc(uRef, { expireAt: exp, isAnonymous: true });
            }
        }

        initPresence(user.uid);
        setOnline();
        $("#auth-container").addClass("hidden");
        $("#app-wrapper").addClass("visible");
        $("#myName").text(user.displayName || "ゲスト");
        $("#myIconContainer").html(`<div class="icon-container"><img src="${user.photoURL || DEFAULT_AVATAR}" style="width:32px; height:32px; border-radius:50%; object-fit:cover;"><div class="status-dot online"></div></div>`);
        
        // ユーザー名が「ゲスト」の場合、警告バナーを表示
        if (user.displayName === "ゲスト" || !user.displayName) {
            $("#guest-warning-banner").show();
        }
        
        // ログインボーナスチェック（匿名ユーザーは除く）
        if (!user.isAnonymous) {
            const canClaim = await checkLoginBonus();
            if (canClaim) {
                // まだ受け取ってない場合、3秒後に自動表示
                setTimeout(() => {
                    openLoginBonusModal();
                }, 3000);
            }
        }
        
        // テーマを適用
        applyUserTheme();
        
        // 通知ボタンのUIを初期化
        updateNotificationButtonUI();
        
        const unsubFriends = onSnapshot(collection(db, "friendRequests"), (snap) => {
            friendIds = [];
            
            // 変更を検知してフレンド申請通知を表示
            snap.docChanges().forEach(change => {
                const data = change.doc.data();
                const reqId = change.doc.id;
                
                // 新しいフレンド申請が来た場合
                if (change.type === "added" && data.to === user.uid && data.status === "pending") {
                    // 送信者の情報を取得
                    const senderData = usersCache[data.from];
                    const senderName = senderData ? senderData.name : "ゲスト";
                    const senderPhoto = senderData ? senderData.photo : DEFAULT_AVATAR;
                    
                    // バッジとタイトル更新
                    triggerBadge("friend_request_" + reqId);
                    
                    // 音を鳴らす
                    if (isSoundEnabled) {
                        notifyAudio.currentTime = 0;
                        notifyAudio.play().catch(e => console.log("Audio play blocked", e));
                    }
                    
                    // ブラウザ通知
                    if (notificationsEnabled) {
                        const n = new Notification("新しいフレンド申請", {
                            body: `${senderName}さんからフレンド申請が届きました`,
                            icon: senderPhoto,
                            tag: 'friend-request-' + reqId
                        });
                        n.onclick = () => { 
                            window.focus(); 
                            $("#openUserListBtn").click();
                        };
                    }
                    
                    console.log("New friend request from:", senderName);
                }
                
                // フレンド申請が承認された場合
                if (change.type === "modified" && data.from === user.uid && data.status === "accepted") {
                    const accepterData = usersCache[data.to];
                    const accepterName = accepterData ? accepterData.name : "ゲスト";
                    const accepterPhoto = accepterData ? accepterData.photo : DEFAULT_AVATAR;
                    
                    // 承認通知
                    if (notificationsEnabled) {
                        const n = new Notification("フレンド申請が承認されました", {
                            body: `${accepterName}さんがフレンド申請を承認しました`,
                            icon: accepterPhoto,
                            tag: 'friend-accepted-' + reqId
                        });
                        n.onclick = () => { 
                            window.focus(); 
                            openDM(data.to, accepterName);
                        };
                    }
                    
                    console.log("Friend request accepted by:", accepterName);
                }
            });
            
            // フレンドリストを更新
            snap.forEach(d => {
                const data = d.data();
                if (data.status === "accepted") {
                    if (data.from === user.uid) friendIds.push(data.to);
                    if (data.to === user.uid) friendIds.push(data.from);
                }
            });
            if ($("#sidebar").hasClass("open")) updateSidebarDMList();
        });

        // ユーザー状態の更新をデバウンス（パフォーマンス向上）
        const updateUserStatuses = debounce(() => {
            Object.keys(usersCache).forEach(uid => {
                const userData = usersCache[uid];
                const statusClass = userData.status === 'online' ? 'online' : 'offline';
                
                // DOM更新を最小限に
                const $messageDots = $(`.message[data-uid="${uid}"] .status-dot`);
                const $sidebarDots = $(`.sidebar-item[data-user-id="${uid}"] .status-dot`);
                
                if ($messageDots.length) {
                    $messageDots.removeClass('online offline').addClass(statusClass);
                }
                if ($sidebarDots.length) {
                    $sidebarDots.removeClass('online offline').addClass(statusClass);
                }
                
                // ユーザーリストモーダルが開いている時だけ更新
                if (!$("#user-list-modal").hasClass("hidden")) {
                    const $userDots = $(`.user-item[data-uid="${uid}"] .status-dot`);
                    if ($userDots.length) {
                        $userDots.removeClass('online offline').addClass(statusClass);
                    }
                }
            });
        }, 100); // 100ms デバウンス
        
        const unsubUsers = onSnapshot(collection(db, "users"), (snap) => {
            let typingNames = [];
            
            // 変更があったユーザーだけ処理（パフォーマンス向上）
            snap.docChanges().forEach(change => {
                const userDoc = change.doc;
                const userData = userDoc.data();
                const uid = userDoc.id;
                
                usersCache[uid] = userData;
                
                if(uid !== auth.currentUser.uid && userData.isTyping) {
                    typingNames.push(userData.name || "ゲスト");
                }
            });
            
            // タイピングインジケーターの更新
            if(typingNames.length > 0) {
                $("#typing-indicator").text(typingNames.map(n => escapeHTML(n)).join(", ") + " が入力中...").removeClass("hidden");
            } else {
                $("#typing-indicator").addClass("hidden");
            }
            
            // 状態ドットの更新（デバウンス）
            updateUserStatuses();
        });

        // --- 新着DM（バックグラウンド）検知用のリスナー ---
        // 自分が参加している部屋の更新を監視
        const unsubRooms = onSnapshot(query(collection(db, "rooms"), where("users", "array-contains", user.uid)), (snap) => {
            snap.docChanges().forEach(change => {
                if(change.type === "modified" || change.type === "added") {
                    const d = change.doc.data();
                    const roomId = change.doc.id;
                    
                    // 自分以外の更新で、かつ現在開いている部屋ではない場合
                    if (d.updatedBy && d.updatedBy !== user.uid && roomId !== currentRoomId) {
                        // 最終閲覧時刻より新しい更新かチェック
                        const lastSeen = lastSeenTimestamps[roomId] || 0;
                        const updatedTime = d.updatedAt ? d.updatedAt.toMillis() : Date.now();
                        
                        if(updatedTime > lastSeen) {
                            triggerBadge(roomId);
                        }
                    }
                }
            });
            
            // サイドバーのDMリストを更新
            if ($("#sidebar").hasClass("open")) {
                updateSidebarDMList();
            }
        });

        globalUnsubscribers.push(unsubFriends, unsubUsers, unsubRooms);
        switchChat(null);
        listenForCalls();
        initStampPicker();
    } else {
        $("#app-wrapper").removeClass("visible");
        $("#auth-container").removeClass("hidden");
        globalUnsubscribers.forEach(unsub => unsub());
        globalUnsubscribers = [];
    }
});

const syncProfilePreview = () => {
    $("#editPreviewName").text($("#editName").val() || "ゲスト");
    $("#editPreviewAvatar").attr("src", $("#editPhoto").val() || DEFAULT_AVATAR);
    $("#editPreviewBanner").attr("src", $("#editBanner").val() || DEFAULT_BANNER);
    $("#editPreviewBio").text($("#editBio").val() || "自己紹介はまだありません。");
    
    // エフェクトプレビュー
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
    
    // バッジプレビュー
    const selectedBadge = $("#editEquippedBadge").val();
    const $badgePreview = $("#editPreviewBadge").empty();
    
    if (selectedBadge === 'vip_badge') {
        $badgePreview.html('<span class="user-badge" title="VIP">👑</span>');
    } else if (selectedBadge === 'star_badge') {
        $badgePreview.html('<span class="user-badge" title="スター">⭐</span>');
    } else if (selectedBadge === 'crown_badge') {
        $badgePreview.html('<span class="user-badge" title="プレミアム">👸</span>');
    }
};
$("#editName, #editPhoto, #editBanner, #editBio, #editEquippedEffect, #editEquippedBadge").on("input change", syncProfilePreview);

window.switchChat = (roomId, otherName = null, otherUid = null) => {
    currentRoomId = roomId;
    currentDMOtherUid = otherUid;
    isInitialLoad = true;
    lastMsgCount = 0;
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
        $("#headerTitle").text("グローバルチャット");
        $("#callDMBtn").addClass("hidden");
    }

    const msgQuery = query(colRef, orderBy("createdAt", "desc"), limit(PAGE_SIZE));
    currentUnsubscribe = onSnapshot(msgQuery, (snap) => {
        if (isInitialLoad && !snap.empty) {
            lastVisibleDoc = snap.docs[snap.docs.length - 1];
        }
        renderMessages(snap, true);
        // チャット切り替え後、少し待ってから既読マーク
        if(isInitialLoad) {
            setTimeout(() => {
                if(document.hasFocus() && document.visibilityState === 'visible') {
                    clearUnread();
                }
            }, 500);
        }
    });
};

let isLoadingMoreMessages = false; // 過去メッセージ読み込み中フラグ
let pauseSnapshot = false; // onSnapshotを一時停止するフラグ

// デバウンス関数（連続実行を防ぐ）
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
    isLoadingMoreMessages = true; // フラグを立てる
    pauseSnapshot = true; // onSnapshotの処理を止める
    
    const $box = $("#messages");
    
    // 現在見ている最初のメッセージ要素を基準として保存
    const firstVisibleMessage = $box.children().first()[0];
    const firstMessageId = firstVisibleMessage ? firstVisibleMessage.id : null;
    
    console.log("Before load - first message:", firstMessageId, "scrollTop:", $box.scrollTop());
    
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
        // 逆順にする（古い順に表示するため）
        docs.reverse();
        docs.forEach(item => { html += generateMessageHtml(item.id, item.data); });
        $("#messages").prepend(html);
        
        // 基準メッセージの位置までスクロール（見た目が変わらないように）
        if (firstMessageId) {
            const firstMessageElement = document.getElementById(firstMessageId);
            if (firstMessageElement) {
                // 基準メッセージを画面の同じ位置に保つ
                firstMessageElement.scrollIntoView({ block: 'start', behavior: 'instant' });
                console.log("Scrolled to preserve message:", firstMessageId);
            }
        }
        
        console.log("Loaded more messages, final scrollTop:", $box.scrollTop());
        
    } catch (err) { console.error("Load more error:", err); } 
    finally { 
        isFetchingMore = false;
        // 少し待ってからフラグを下ろす
        setTimeout(() => {
            isLoadingMoreMessages = false;
            pauseSnapshot = false;
            console.log("Resumed normal mode");
        }, 1500);
    }
}

function generateMessageHtml(id, d) {
    const isMe = d.uid === auth.currentUser.uid;
    const isFriend = friendIds.includes(d.uid);
    const reactions = d.reactions || {};
    const userStatus = usersCache[d.uid]?.status || "offline";
    const isStamp = !!d.stamp;
    
    // ユーザーの装備アイテムを取得
    const userData = usersCache[d.uid] || {};
    const equipped = userData.equipped || {};
    
    // 装備されたバッジのみを表示
    let badgeHtml = '';
    const badgeMap = {
        'vip_badge': { icon: '👑', title: 'VIP' },
        'star_badge': { icon: '⭐', title: 'スター' },
        'crown_badge': { icon: '👸', title: 'プレミアム' }
    };
    if (equipped.badge && badgeMap[equipped.badge]) {
        const badge = badgeMap[equipped.badge];
        badgeHtml = `<span class="user-badge" title="${badge.title}">${badge.icon}</span>`;
    }
    
    // 装備されたエフェクトのみを適用（メッセージ全体に）
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
    // リアクションの表示順をreactionEmojisの順で固定（追加順で変わらないように）
    const reactionOrder = ['👍','❤️','😂','😮','😢','😡','🙏','👏','🎉','🔥','✨','💯','👀','🤔','😅','😊','🥰','😎','🤩','😇','🤗','🙌','✅','❌','⭐','💪','👌','🎊','🎈','💕'];
    const sortedReactions = Object.entries(reactions).sort((a, b) => {
        const ai = reactionOrder.indexOf(a[0]);
        const bi = reactionOrder.indexOf(b[0]);
        return (ai === -1 ? 999 : ai) - (bi === -1 ? 999 : bi);
    });
    for (const [emoji, uids] of sortedReactions) {
        if (uids.length > 0) rHtml += `<div class="reaction-badge ${uids.includes(auth.currentUser.uid)?'active':''}" onclick="react('${id}','${emoji}',${JSON.stringify(reactions).replace(/"/g, '&quot;')})">${emoji} ${uids.length}</div>`;
    }
    const imgHtml = d.image ? `<img src="${d.image}" class="sent-img" onclick="window.open('${d.image}')">` : '';
    const stampHtml = d.stamp ? `<img src="${d.stamp}" class="stamp-display">` : '';
    const safeName = escapeHTML(d.name || "ゲスト");
    const safeText = escapeHTML(d.text || "");
    const replyName = d.replyTo ? escapeHTML(d.replyTo.name) : "";
    const replyText = d.replyTo ? escapeHTML(d.replyTo.text) : "";

    return `<div class="message ${isMe?'me':''} ${isStamp?'is-stamp':''} ${isFriend?'is-friend':''} ${effectClass}" id="msg-${id}" data-uid="${d.uid}" data-msgid="${id}" data-is-me="${isMe}" data-is-stamp="${isStamp}" data-name="${safeName.replace(/"/g,'&quot;')}" data-text="${safeText.replace(/"/g,'&quot;').replace(/\n/g,' ')}">
        <div class="icon-container" onclick="showProfile('${d.uid}')">
            <img src="${d.photo || DEFAULT_AVATAR}" class="icon">
            <div class="status-dot ${userStatus === 'online' ? 'online' : 'offline'}"></div>
        </div>
        <div class="msg-body">
            <div class="user-info">${safeName}${badgeHtml}</div>
            <div class="bubble">
                ${d.replyTo ? `<div class="reply-in-bubble" onclick="scrollToMsg('${d.replyTo.id}')">@${replyName} ${replyText}</div>` : ''}
                ${d.text ? `<div>${safeText}${d.isEdited ? '<span class="edited-mark">(編集済)</span>' : ''}</div>` : ''}
                ${imgHtml}
                ${stampHtml}
            </div>
            <div class="msg-ops">
                ${rHtml}
                <span class="material-symbols-outlined op-btn" onclick="openReactionPicker('${id}', event, ${JSON.stringify(reactions).replace(/"/g, '&quot;')})" title="リアクション">add_reaction</span>
                <span class="material-symbols-outlined op-btn" onclick="setReply('${id}','${safeName.replace(/'/g, "\\'")}','${(safeText || (isStamp?"スタンプ":"画像")).replace(/'/g, "\\'").replace(/\n/g, " ")}')" title="返信">reply</span>
                ${isMe && !isStamp ? `<span class="material-symbols-outlined op-btn" onclick="setEdit('${id}','${safeText.replace(/'/g, "\\'").replace(/\n/g, "\\n")}')" title="編集">edit</span>` : ''}
                ${isMe ? `<span class="material-symbols-outlined op-btn" style="color:var(--danger);" onclick="deleteMsg('${id}')" title="削除">delete</span>` : ''}
            </div>
        </div></div>`;
}

$("#messages").on("scroll", function() { if ($(this).scrollTop() === 0) loadMoreMessages(); });

let notificationsEnabled = localStorage.getItem("chat_notifications_enabled") === "true";

// ページ読み込み時に通知権限をチェックして状態を復元
if ('Notification' in window && Notification.permission === 'granted') {
    notificationsEnabled = localStorage.getItem("chat_notifications_enabled") !== "false";
} else {
    notificationsEnabled = false;
}

function triggerBadge(roomId = null) {
    // DM別の未読カウント
    if(roomId) {
        unreadRooms[roomId] = (unreadRooms[roomId] || 0) + 1;
        updateDMBadges();
    }
    
    // 全体の未読数を再計算
    recalculateTotalUnread();
    
    if (isSoundEnabled) {
        notifyAudio.currentTime = 0;
        notifyAudio.play().catch(e => console.log("Audio play blocked", e));
    }
}

function renderMessages(snap, isDesc = false) {
    // onSnapshotが一時停止中なら何もしない
    if (pauseSnapshot) {
        console.log("renderMessages blocked - pauseSnapshot is true");
        return;
    }
    
    const $box = $("#messages");
    const currentMsgCount = snap.size;
    
    // 過去メッセージ読み込み中は新着メッセージ判定をスキップ
    const hasNewMessage = !isLoadingMoreMessages && (currentMsgCount > lastMsgCount);
    
    let docs = [];
    snap.forEach(d => docs.push({id: d.id, data: d.data()}));
    if(isDesc) docs.reverse();
    
    if (isInitialLoad) {
        // DocumentFragmentを使ってバッチ挿入（パフォーマンス向上）
        const fragment = document.createDocumentFragment();
        const tempDiv = document.createElement('div');
        
        docs.forEach((item) => {
            tempDiv.innerHTML = generateMessageHtml(item.id, item.data);
            while (tempDiv.firstChild) {
                fragment.appendChild(tempDiv.firstChild);
            }
        });
        
        $box.empty();
        $box[0].appendChild(fragment);
        
        // 画像の読み込み完了を待つ
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
        
        // 過去メッセージ読み込み中でなければスクロール
        if (!isLoadingMoreMessages) {
            // 即座に一番下へ
            $box[0].scrollTop = $box[0].scrollHeight;
            
            // 画像読み込み待ちで何度も試行（確実に一番下へ）
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
    } else {
        // 更新が必要なメッセージだけ処理（パフォーマンス向上）
        const updates = [];
        const additions = [];
        
        docs.forEach((item) => {
            const existing = $(`#msg-${item.id}`);
            if (existing.length) {
                updates.push({element: existing, html: generateMessageHtml(item.id, item.data)});
            } else {
                additions.push(generateMessageHtml(item.id, item.data));
            }
        });
        
        // バッチ更新
        updates.forEach(({element, html}) => element.replaceWith(html));
        
        // バッチ追加（DocumentFragment使用）
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
        
        if (hasNewMessage) {
            const lastDoc = docs[docs.length - 1];
            const isMyMessage = auth.currentUser && lastDoc.data.uid === auth.currentUser.uid;

            // DOM確定後に常に一番下へスクロール
            if (!isLoadingMoreMessages) {
                requestAnimationFrame(() => {
                    requestAnimationFrame(() => {
                        $box[0].scrollTop = $box[0].scrollHeight;
                    });
                });
            }
            
            // --- 通知・バッジ処理（強化版） ---
            if (auth.currentUser && lastDoc.data.uid !== auth.currentUser.uid) {
                
                // バッジを表示すべきか判定
                const isAtBottom = ($box[0].scrollHeight - $box.scrollTop() <= $box[0].clientHeight + 150);
                const isUnseen = document.visibilityState === 'hidden' || !document.hasFocus() || !isAtBottom;

                if (isUnseen) {
                    const roomIdForBadge = currentRoomId || "global";
                    
                    // 最終閲覧時刻より新しいメッセージかチェック
                    const lastSeen = lastSeenTimestamps[roomIdForBadge] || 0;
                    const msgTime = lastDoc.data.createdAt ? lastDoc.data.createdAt.toMillis() : Date.now();
                    
                    // 既読済みのメッセージはスキップ
                    if(msgTime > lastSeen) {
                        triggerBadge(roomIdForBadge);
                        
                        // ブラウザ通知（許可されている場合のみ）
                        if (notificationsEnabled && (document.visibilityState === 'hidden' || !document.hasFocus())) {
                            const notificationTitle = `新着: ${lastDoc.data.name || "ゲスト"}`;
                            const notificationBody = lastDoc.data.text || (lastDoc.data.stamp ? "スタンプ" : "画像");
                            const n = new Notification(notificationTitle, {
                                body: notificationBody,
                                icon: lastDoc.data.photo || DEFAULT_AVATAR,
                                tag: 'chat-msg'
                            });
                            n.onclick = () => { window.focus(); };
                        }
                    }
                } else {
                    // 見ている状態なら即座に既読マーク
                    clearUnread();
                }
            }
            // -------------------
        }
    }
    // 過去メッセージ読み込み中でなければlastMsgCountを更新
    // これにより、過去メッセージ読み込み中にonSnapshotが発火しても新着扱いされない
    if (!isLoadingMoreMessages) {
        lastMsgCount = currentMsgCount;
    }
}

let isSending = false; // 送信中フラグ

const send = async () => {
    // 送信中なら何もしない（連打防止）
    if (isSending) return;
    
    const txt = $("#messageInput").val().trim(); 
    if (!txt && !pendingImageUrl) return;
    
    // 送信中フラグを立てる
    isSending = true;
    $("#sendBtn").css("opacity", "0.5").css("pointer-events", "none"); // ボタンを無効化
    
    try {
        const colRef = currentRoomId ? collection(db, "rooms", currentRoomId, "messages") : collection(db, "chats");
        if(editTargetId) {
            await updateDoc(doc(colRef, editTargetId), { text: txt, isEdited: true });
            cancelEdit();
        } else {
            await addDoc(colRef, { text: txt, image: pendingImageUrl, uid: auth.currentUser.uid, name: auth.currentUser.displayName || "ゲスト", photo: auth.currentUser.photoURL || DEFAULT_AVATAR, createdAt: serverTimestamp(), replyTo: replyTarget, reactions: {} });
            
            // DMの場合、親ルーム情報の更新日時を更新（他のユーザーに通知を飛ばすため）
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
        // 送信完了後、フラグを下ろしてボタンを有効化
        setTimeout(() => {
            isSending = false;
            $("#sendBtn").css("opacity", "1").css("pointer-events", "auto");
        }, 500); // 0.5秒のクールダウン
    }
};

let isCurrentlyTyping = false; // 現在の入力中状態を記録

const updateTypingStatus = async (isTyping) => {
    if(!auth.currentUser) return;
    // 状態が変わった時だけFirestoreに書き込む
    if (isCurrentlyTyping !== isTyping) {
        isCurrentlyTyping = isTyping;
        await updateDoc(doc(db, "users", auth.currentUser.uid), { isTyping: isTyping });
    }
};

$("#messageInput").on("input", function() {
    // 入力開始時のみFirestoreに書き込む（連続入力では書き込まない）
    if (!isCurrentlyTyping) {
        updateTypingStatus(true);
    }
    clearTimeout(typingTimeout);
    typingTimeout = setTimeout(() => updateTypingStatus(false), 3000);
});

window.sendStamp = async (url) => {
    const colRef = currentRoomId ? collection(db, "rooms", currentRoomId, "messages") : collection(db, "chats");
    await addDoc(colRef, { stamp: url, uid: auth.currentUser.uid, name: auth.currentUser.displayName || "ゲスト", photo: auth.currentUser.photoURL || DEFAULT_AVATAR, createdAt: serverTimestamp(), replyTo: replyTarget, reactions: {} });
    
     // DMの場合、親ルーム情報の更新日時を更新
    if (currentRoomId) {
        await updateDoc(doc(db, "rooms", currentRoomId), { lastMessage: "スタンプ", updatedAt: serverTimestamp(), updatedBy: auth.currentUser.uid });
    }

    replyTarget = null; $("#reply-preview").addClass("hidden"); $("#stamp-modal").addClass("hidden");
    scrollToBottom(true);
};

const initStampPicker = () => {
    const $list = $("#stamp-list").empty();
    STAMP_LIST.forEach(url => { $list.append(`<img src="${url}" class="stamp-item" onclick="sendStamp('${url}')">`); });
};

// ========== アイテム効果適用 ==========

// ユーザーのテーマを適用
async function applyUserTheme() {
    try {
        const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
        const userData = userDoc.data();
        const equipped = userData.equipped || {};
        
        // 既存のテーマクラスを削除
        $('body').removeClass('rainbow-theme heart-theme');
        
        // 装備しているテーマを適用
        if (equipped.theme === 'rainbow_theme') {
            $('body').addClass('rainbow-theme');
            console.log('🌈 Rainbow theme applied');
        } else if (equipped.theme === 'heart_theme') {
            $('body').addClass('heart-theme');
            console.log('💕 Heart theme applied');
        }
    } catch (error) {
        console.error('Theme application error:', error);
    }
}

// ========== ショップシステム ==========

// 🔐 管理者メールアドレスリスト（全アイテム自動解放 + 無限コイン）
// ⚠️ 本番環境では必ず実際のメールアドレスに変更してください
const ADMIN_EMAILS = [
    // 'your-email@example.com',  // ← ここに管理者のメールアドレスを追加
    // 'admin@example.com'
];

const shopItems = [
    { id: 'vip_badge', name: 'VIPバッジ', icon: '👑', price: 300, description: '名前の横にVIPバッジが表示されます' },
    { id: 'rainbow_theme', name: 'レインボーテーマ', icon: '🌈', price: 250, description: 'チャット背景が虹色に' },
    { id: 'fire_effect', name: '炎エフェクト', icon: '🔥', price: 200, description: 'メッセージに炎エフェクト' },
    { id: 'star_badge', name: 'スターバッジ', icon: '⭐', price: 150, description: '名前の横にスターが表示' },
    { id: 'heart_theme', name: 'ハートテーマ', icon: '💕', price: 180, description: 'ピンク色のテーマ' },
    { id: 'sparkle_effect', name: 'キラキラエフェクト', icon: '✨', price: 220, description: 'メッセージがキラキラ' },
    { id: 'crown_badge', name: 'クラウンバッジ', icon: '👸', price: 350, description: 'プレミアムクラウン' },
    { id: 'lightning_effect', name: '稲妻エフェクト', icon: '⚡', price: 280, description: 'メッセージに稲妻' },
    { id: 'rainbow_effect', name: '虹色エフェクト', icon: '🌟', price: 300, description: '虹色に輝くオーラ' },
    { id: 'shadow_effect', name: 'シャドウエフェクト', icon: '🌑', price: 250, description: '暗黒のオーラ' },
    { id: 'ice_effect', name: '氷エフェクト', icon: '❄️', price: 260, description: '氷の結晶エフェクト' },
    { id: 'toxic_effect', name: '毒エフェクト', icon: '☠️', price: 270, description: '紫色の毒々しいオーラ' },
    { id: 'gold_effect', name: 'ゴールドエフェクト', icon: '💛', price: 400, description: '金色に輝く豪華なオーラ' }
];

// 管理者かどうかチェック
function isAdmin(email) {
    return ADMIN_EMAILS.includes(email);
}

// 管理者権限の自動付与
async function unlockAllItemsForAdmin() {
    if (!auth.currentUser || !auth.currentUser.email) return;
    
    if (isAdmin(auth.currentUser.email)) {
        try {
            const allItemIds = shopItems.map(item => item.id);
            
            await setDoc(doc(db, "users", auth.currentUser.uid), {
                ownedItems: allItemIds,
                isAdmin: true,
                coins: 999999  // 管理者には無限コイン
            }, { merge: true });
            
            console.log('🔓 Admin detected: All items unlocked');
        } catch (error) {
            console.error('Admin unlock error:', error);
        }
    }
}

// ログインボーナスのチェック
async function checkLoginBonus() {
    try {
        // 管理者チェック
        await unlockAllItemsForAdmin();
        
        // Firestoreから最終ログイン日を取得
        const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
        if (!userDoc.exists()) {
            return true; // 初回ログイン
        }
        
        const userData = userDoc.data();
        const lastLogin = userData.lastLogin;
        
        if (!lastLogin) {
            return true; // lastLoginがない場合は受け取り可能
        }
        
        // Firestoreのタイムスタンプから日付を取得（UTC）
        const lastLoginDate = lastLogin.toDate();
        const now = new Date();
        
        // 日付を比較（年-月-日のみ）
        const lastLoginDay = new Date(lastLoginDate.getFullYear(), lastLoginDate.getMonth(), lastLoginDate.getDate());
        const today = new Date(now.getFullYear(), now.getMonth(), now.getDate());
        
        // 最終ログインが今日より前なら受け取り可能
        const canClaim = lastLoginDay.getTime() < today.getTime();
        
        console.log('Login bonus check:', {
            lastLoginDate: lastLoginDay.toISOString(),
            today: today.toISOString(),
            canClaim
        });
        
        return canClaim;
        
    } catch (error) {
        console.error('Check login bonus error:', error);
        return false;
    }
}

// ログインボーナスを受け取る
async function claimLoginBonus() {
    try {
        // 再度チェック（二重受け取り防止）
        const canClaim = await checkLoginBonus();
        if (!canClaim) {
            return { success: false, message: '今日のボーナスは既に受け取り済みです' };
        }
        
        const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
        const userData = userDoc.data();
        const currentCoins = userData.coins || 0;
        const isAdminUser = userData.isAdmin || false;
        
        // 管理者は既に999999コインあるのでボーナス不要
        if (isAdminUser) {
            // lastLoginだけ更新
            await setDoc(doc(db, "users", auth.currentUser.uid), {
                lastLogin: serverTimestamp()
            }, { merge: true });
            
            return { success: true, message: '管理者は常に無限コインです', coins: 999999, bonus: 0 };
        }
        
        // 通常ユーザー: +100コイン + lastLogin更新
        await setDoc(doc(db, "users", auth.currentUser.uid), {
            coins: currentCoins + 100,
            lastLogin: serverTimestamp()
        }, { merge: true });
        
        return { success: true, message: '+100コイン獲得！', coins: currentCoins + 100, bonus: 100 };
        
    } catch (error) {
        console.error('Claim login bonus error:', error);
        return { success: false, message: 'エラーが発生しました: ' + error.message };
    }
}

// ログインボーナス画面を開く
async function openLoginBonusModal() {
    $('#login-bonus-modal').removeClass('hidden');
    
    // 現在のコインを表示
    const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
    const userData = userDoc.data();
    const currentCoins = userData.coins || 0;
    $('#bonus-current-coins').text(currentCoins.toLocaleString());
    
    // 受け取り状態をチェック
    const canClaim = await checkLoginBonus();
    
    if (canClaim) {
        // まだ受け取ってない
        $('#bonus-claim-section').removeClass('hidden');
        $('#bonus-already-claimed').addClass('hidden');
    } else {
        // 既に受け取り済み
        $('#bonus-claim-section').addClass('hidden');
        $('#bonus-already-claimed').removeClass('hidden');
    }
}

// ========== スロットマシン ==========
const slotSymbols = ['🍒', '🍋', '🍊', '🍇', '⭐', '💎', '🎁'];
const slotPayouts = {
    '🍒': 5,
    '🍋': 8,
    '🍊': 12,
    '🍇': 20,
    '⭐': 40,
    '💎': 100,
    '🎁': 0  // 強化スピン発動（配当なし）
};
let isSpinning = false;
let hasSpecialSpin = false;
let boostedSpinsRemaining = 0; // 強化スピン残り回数
let currentBet = 1; // ベット倍率

// ベット選択
$('.bet-btn').on('click', function() {
    if (isSpinning) return;
    
    const newBet = parseInt($(this).data('bet'));
    
    // 強化スピン中にベット変更しようとした場合
    if (boostedSpinsRemaining > 0 && newBet !== currentBet) {
        if (!confirm(`🔥 強化スピン中です！\n\nベットを変更すると強化スピンが消えますがよろしいですか？\n\n残り: ${boostedSpinsRemaining}回`)) {
            return; // キャンセル
        }
        // 「はい」を押した場合、強化スピンをリセット
        boostedSpinsRemaining = 0;
        updateBoostedSpinsDisplay();
    }
    
    $('.bet-btn').removeClass('active').css('border-color', '#666');
    $(this).addClass('active');
    currentBet = newBet;
    
    const cost = 10 * currentBet;
    $('#spin-btn-cost').text(`- ${cost} COINS -`);
    $('#bet-multiplier-text').text(`(×${currentBet})`);
    
    // 配当表を更新
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

// リールストリップを初期化
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

// スロット画面を開く
$('#openSlotBtn').on('click', async () => {
    $('#slot-modal').removeClass('hidden');
    initReelStrips();
    
    // コイン残高を更新
    const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
    const coins = userDoc.data().coins || 0;
    $('#slot-coins').text(String(coins).padStart(4, '0'));
    $('#slot-result-display').addClass('hidden');
    
    if (hasSpecialSpin) {
        $('#special-spin-indicator').removeClass('hidden');
    } else {
        $('#special-spin-indicator').addClass('hidden');
    }
});

// スロットは全画面UIなので背景クリック閉じは不要

// リールをコマ送りで回す（上→下方向のみ、戻り動作なし）
function spinReel(reelId, targetSymbol, duration) {
    return new Promise((resolve) => {
        const strip = $(`#strip${reelId}`);

        // ストリップを毎回完全再生成
        strip.empty();
        strip.css({ transition: 'none', top: '0px' });

        // 40コマ生成（0〜38はランダム、39=停止シンボル）
        const TOTAL = 40;
        const stopIndex = TOTAL - 1;
        for (let j = 0; j < TOTAL; j++) {
            const sym = (j === stopIndex)
                ? targetSymbol
                : slotSymbols[Math.floor(Math.random() * slotSymbols.length)];
            strip.append(`<div class="slot-symbol-item">${sym}</div>`);
        }

        // シンボル高さを実測
        const symH = strip.find('.slot-symbol-item').first().outerHeight() || 150;

        // 各フレームの間隔を加速→高速→減速で計算
        const frames = [];
        const accelFrames  = Math.floor(TOTAL * 0.15); // 加速
        const decelFrames  = Math.floor(TOTAL * 0.25); // 減速
        const constFrames  = TOTAL - accelFrames - decelFrames; // 高速
        const minInterval  = 16;   // 高速時 (ms)
        const maxInterval  = 120;  // 加速/減速時 (ms)

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
                // 最終位置にぴったり合わせる
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

        // 少し待ってから開始（前のリールとの間隔演出）
        playSlotSpinSound(frames.length);
        setTimeout(nextFrame, 0);
    });
}

// スピンボタン
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

    // コイン消費
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
        // バラバラ（1=2にも1=2=3にもならないよう保証）
        do {
            results = [
                slotSymbols[Math.floor(Math.random() * slotSymbols.length)],
                slotSymbols[Math.floor(Math.random() * slotSymbols.length)],
                slotSymbols[Math.floor(Math.random() * slotSymbols.length)],
            ];
        } while (results[0] === results[1] || results[1] === results[2] || results[0] === results[2]);
    }

    // ===== 演出判定 =====
    const isWin       = willWin;
    const isDiamond   = isWin && results[0] === '💎';
    const isSevenStar = isWin && results[0] === '⭐';
    const isReach     = willReachMiss;

    // 💎は常に確定演出、⭐は50%、通常当たりは20%、リーチは30%の確率で演出あり
    const showPreEffect  = isDiamond ? true
                         : isSevenStar ? Math.random() < 0.50
                         : isWin       ? Math.random() < 0.20
                         : false;
    const showReachEffect = isReach && Math.random() < 0.30;

    // 当たり確定フラッシュ（スピン前）
    if (showPreEffect) {
        if (isDiamond)   { showSlotEffect('jackpot'); await wait(600); }
        else if (isSevenStar) { showSlotEffect('star'); await wait(400); }
        else             { showSlotEffect('win');     await wait(300); }
        hideSlotEffect();
    }

    // リール1
    await spinReel(1, results[0]);
    playReelStopSound(0);
    await wait(250);

    // リール2
    await spinReel(2, results[1]);
    playReelStopSound(1);

    // リーチ演出（確率で出る）
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

    // リール3
    await spinReel(3, results[2]);
    playReelStopSound(2);

    $('#reach-effect').addClass('hidden');
    await wait(350);

    checkSlotResult(results, currentCoins - betCost, isWin, willReachMiss, isDiamond, isSevenStar);
});

function wait(ms) { return new Promise(r => setTimeout(r, ms)); }

// 演出エフェクト表示
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
    
    // 強化スピンカウントダウン
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
        // 🎁🎁🎁 = 強化スピン発動
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

        // 当たり演出（💎は常に、⭐は60%、通常は25%）
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
        // リーチ外れ演出（40%）
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

// 強化スピン表示更新
function updateBoostedSpinsDisplay() {
    const $indicator = $('#boosted-spins-indicator');
    if (boostedSpinsRemaining > 0) {
        $indicator.text(`🔥 BOOSTED ×${boostedSpinsRemaining}`).removeClass('hidden');
    } else {
        $indicator.addClass('hidden');
    }
}

// ログインボーナスボタン
$('#openLoginBonusBtn').on('click', openLoginBonusModal);

// ログインボーナス受け取りボタン
$('#claimBonusBtn').on('click', async () => {
    const $btn = $('#claimBonusBtn');
    $btn.prop('disabled', true).text('受け取り中...');
    
    const result = await claimLoginBonus();
    
    if (result.success) {
        // 成功アニメーション
        $('#bonus-amount').text(`+${result.bonus}`);
        $('#bonus-current-coins').text(result.coins.toLocaleString());
        
        // ボタンを非表示にして受け取り済み表示
        $('#bonus-claim-section').addClass('hidden');
        $('#bonus-already-claimed').removeClass('hidden');
        
        // 成功メッセージ
        setTimeout(() => {
            alert('🎉 ' + result.message);
        }, 300);
    } else {
        alert('❌ ' + result.message);
        $btn.prop('disabled', false).text('受け取る');
    }
});


// ショップデータ読み込み
async function loadShopData() {
    const userDoc = await getDoc(doc(db, "users", auth.currentUser.uid));
    const userData = userDoc.data();
    const userCoins = userData.coins || 0;
    const ownedItems = userData.ownedItems || [];
    const isAdminUser = userData.isAdmin || false;
    
    // プレビュー用に現在のユーザー情報を保存
    const currentUserName = userData.name || 'あなた';
    const currentUserPhoto = userData.photo || DEFAULT_AVATAR;
    
    // 管理者表示
    if (isAdminUser) {
        $('#user-coins').html('∞ <span style="font-size:14px; color:rgba(255,255,255,0.7);">(管理者)</span>');
    } else {
        $('#user-coins').text(userCoins);
    }
    
    const $container = $('#shop-items').empty();
    const $preview = $('#item-preview');
    
    shopItems.forEach(item => {
        const owned = ownedItems.includes(item.id);
        const canAfford = userCoins >= item.price;
        
        const $item = $(`
            <div class="shop-item ${owned ? 'owned' : ''}" data-item-id="${item.id}" onclick="${owned ? '' : `purchaseItem('${item.id}')`}">
                <div class="shop-item-icon">${item.icon}</div>
                <div class="shop-item-name">${item.name}</div>
                ${owned ? 
                    '<div class="shop-item-owned">✅ 所持中</div>' :
                    `<div class="shop-item-price">💰 ${item.price}</div>`
                }
            </div>
        `);
        
        // PC: ホバーでプレビュー / スマホ: タップ制御
        if (window.matchMedia('(max-width: 600px)').matches) {
            // スマホはonclickを無効化してJS側で制御
            $item.attr('onclick', '');
            $item.on('click', function(e) {
                e.preventDefault();
                e.stopPropagation();
                if (owned) {
                    showItemPreview(item, currentUserName, currentUserPhoto);
                    return;
                }
                const prevId = $('#item-preview').data('previewId');
                const isVisible = !$('#item-preview').hasClass('hidden');
                if (!isVisible || prevId !== item.id) {
                    // 1回目タップ: プレビュー表示のみ（テーマ適用しない）
                    showItemPreview(item, currentUserName, currentUserPhoto);
                    $('#item-preview').data('previewId', item.id);
                    setTimeout(() => {
                        const el = document.getElementById('item-preview');
                        if (el) el.scrollIntoView({ behavior: 'smooth', block: 'nearest' });
                    }, 100);
                } else {
                    // 2回目タップ: 購入
                    window.purchaseItem(item.id);
                    $('#item-preview').addClass('hidden').data('previewId', null);
                }
            });
        } else {
            $item.on('mouseenter', function() {
                showItemPreview(item, currentUserName, currentUserPhoto);
            });
        }
        
        $container.append($item);
    });
    
    // プレビューエリアから出た時だけ非表示
    let previewTimeout;
    $container.on('mouseleave', function() {
        previewTimeout = setTimeout(() => {
            if (!$preview.is(':hover')) {
                $preview.addClass('hidden');
            }
        }, 200);
    });
    
    $preview.on('mouseenter', function() {
        clearTimeout(previewTimeout);
    });
    
    $preview.on('mouseleave', function() {
        $preview.addClass('hidden');
    });
}

// アイテムプレビュー表示
function showItemPreview(item, userName, userPhoto) {
    $('#item-preview').removeClass('hidden');
    $('#preview-item-name').text(item.name);
    $('#preview-item-desc').text(item.description);
    $('#preview-name').text(userName);
    $('#preview-icon').attr('src', userPhoto);
    
    // プレビューメッセージのクラスをリセット（全エフェクト）
    $('#preview-message').removeClass('effect-fire effect-sparkle effect-lightning effect-rainbow effect-shadow effect-ice effect-toxic effect-gold');
    $('#preview-icon-container').removeClass('effect-fire effect-sparkle effect-lightning effect-rainbow effect-shadow effect-ice effect-toxic effect-gold');
    $('#preview-badge').empty();
    // テーマプレビュー用リセット
    $('#item-preview').css('background', '');
    
    // アイテムタイプに応じてプレビュー
    if (item.id === 'vip_badge' || item.id === 'star_badge' || item.id === 'crown_badge') {
        // バッジプレビュー
        const badgeMap = {
            'vip_badge': { icon: '👑', title: 'VIP' },
            'star_badge': { icon: '⭐', title: 'スター' },
            'crown_badge': { icon: '👸', title: 'プレミアム' }
        };
        const badge = badgeMap[item.id];
        $('#preview-badge').html(`<span class="user-badge" title="${badge.title}">${badge.icon}</span>`);
        
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

// アイテム購入
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
        
        // 購入処理
        await setDoc(doc(db, "users", auth.currentUser.uid), {
            coins: userCoins - item.price,
            ownedItems: arrayUnion(itemId)
        }, { merge: true });
        
        alert(`🎉 ${item.name}を購入しました！`);
        
        // テーマアイテムを購入した場合、即座に適用
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


// ショップボタン（ヘッダー + 旧メニュー内）
$('#openShopBtnHeader, #openShopBtn').on('click', () => {
    $('#other-settings-modal').addClass('hidden');
    $('#shop-modal').removeClass('hidden');
    loadShopData();
});

// 通知ボタン（設定モーダル内）
$('#toggleNotificationBtn').on('click', async () => {
    if ('Notification' in window) {
        if (Notification.permission === 'granted') {
            notificationsEnabled = !notificationsEnabled;
            localStorage.setItem('chat_notifications_enabled', notificationsEnabled);
            updateNotificationButtonUI();
        } else if (Notification.permission === 'default') {
            const permission = await Notification.requestPermission();
            if (permission === 'granted') {
                notificationsEnabled = true;
                localStorage.setItem('chat_notifications_enabled', 'true');
                updateNotificationButtonUI();
            }
        } else {
            alert('ブラウザの設定で通知を許可してください');
        }
    }
});

function updateNotificationButtonUI() {
    const $btn = $('#toggleNotificationBtn');
    const $text = $('#notificationBtnText');
    const $icon = $btn.find('.material-symbols-outlined');
    
    if (notificationsEnabled) {
        $btn.removeClass('btn-toggle-off').addClass('btn-toggle-on');
        $text.text('通知: ON');
        $icon.text('notifications');
    } else {
        $btn.removeClass('btn-toggle-on').addClass('btn-toggle-off');
        $text.text('通知: OFF');
        $icon.text('notifications_off');
    }
}

window.react = async (id, emoji, currentJson) => {
    const colRef = currentRoomId ? collection(db, "rooms", currentRoomId, "messages") : collection(db, "chats");
    const users = (currentJson && currentJson[emoji]) || [];
    await updateDoc(doc(colRef, id), { [`reactions.${emoji}`]: users.includes(auth.currentUser.uid) ? arrayRemove(auth.currentUser.uid) : arrayUnion(auth.currentUser.uid) });
};

// リアクションピッカーの絵文字リスト
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
    
    // 絵文字を配置
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
    
    // 一旦表示して実際のサイズを取得
    $picker.css({ left: '0px', top: '0px', visibility: 'hidden' }).removeClass('hidden');
    const pickerWidth = $picker.outerWidth();
    const pickerHeight = $picker.outerHeight();
    $picker.addClass('hidden').css('visibility', 'visible');
    
    const windowWidth = window.innerWidth;
    const windowHeight = window.innerHeight;
    const padding = 10;
    
    // スマホ: タッチ座標 or クリック座標を使う
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

// ピッカー外をクリックしたら閉じる
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
$("#stampBtn").on("click", () => $("#stamp-modal").removeClass("hidden"));

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
    
    // 基本情報
    $("#viewName").text(d.name || "ゲスト"); 
    $("#viewAvatar").attr("src", d.photo || DEFAULT_AVATAR); 
    $("#viewBanner").attr("src", d.banner || DEFAULT_BANNER); 
    $("#viewBio").text(d.bio || "No bio.");
    
    // オンライン状態
    const statusClass = d.status === 'online' ? 'online' : 'offline';
    $("#viewStatusDot").removeClass('online offline').addClass(statusClass);
    
    // エフェクト適用
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
    
    // バッジ表示
    const $badges = $("#viewBadges").empty();
    if (equipped.badge === 'vip_badge') {
        $badges.append('<span class="user-badge" title="VIP">👑</span>');
    } else if (equipped.badge === 'star_badge') {
        $badges.append('<span class="user-badge" title="スター">⭐</span>');
    } else if (equipped.badge === 'crown_badge') {
        $badges.append('<span class="user-badge" title="プレミアム">👸</span>');
    }
    
    // アクションボックス
    const $actionBox = $("#prof-action-box").empty();
    if (uid !== auth.currentUser.uid) {
        const reqId = [auth.currentUser.uid, uid].sort().join("_");
        const rSnap = await getDoc(doc(db, "friendRequests", reqId));
        if (!rSnap.exists()) $actionBox.append(`<button onclick="sendRequest('${uid}')" class="btn-sm" style="background:var(--accent);">申請</button>`);
        else if (rSnap.data().status === "accepted") {
            $actionBox.append(`<button onclick="openDM('${uid}','${escapeHTML(d.name || "ゲスト").replace(/'/g, "\\'")}')" class="btn-sm" style="background:var(--success);">DMを送る</button>`);
            $actionBox.append(`<span style="color:var(--friend-gold); font-size:12px; margin-left:10px;">★</span>`);
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
        
        // アイテム装備の選択肢を読み込む
        await loadEquipmentOptions(d);
    }
    syncProfilePreview(); 
    $("#settings-modal").removeClass("hidden");
});

// アイテム装備の選択肢を読み込む
async function loadEquipmentOptions(userData) {
    const ownedItems = userData.ownedItems || [];
    const equipped = userData.equipped || {};
    
    // バッジの選択肢
    const $badgeSelect = $('#editEquippedBadge').empty();
    $badgeSelect.append('<option value="">なし</option>');
    if (ownedItems.includes('vip_badge')) $badgeSelect.append('<option value="vip_badge">👑 VIPバッジ</option>');
    if (ownedItems.includes('star_badge')) $badgeSelect.append('<option value="star_badge">⭐ スターバッジ</option>');
    if (ownedItems.includes('crown_badge')) $badgeSelect.append('<option value="crown_badge">👸 クラウンバッジ</option>');
    $badgeSelect.val(equipped.badge || '');
    
    // テーマの選択肢
    const $themeSelect = $('#editEquippedTheme').empty();
    $themeSelect.append('<option value="">デフォルト</option>');
    if (ownedItems.includes('rainbow_theme')) $themeSelect.append('<option value="rainbow_theme">🌈 レインボーテーマ</option>');
    if (ownedItems.includes('heart_theme')) $themeSelect.append('<option value="heart_theme">💕 ハートテーマ</option>');
    $themeSelect.val(equipped.theme || '');
    
    // エフェクトの選択肢
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
        equipped: {
            badge: $("#editEquippedBadge").val(),
            theme: $("#editEquippedTheme").val(),
            effect: $("#editEquippedEffect").val()
        }
    };
    await updateProfile(auth.currentUser, { displayName: data.name, photoURL: data.photo });
    await setDoc(doc(db, "users", auth.currentUser.uid), data, { merge: true });
    
    // テーマを即座に適用
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
        // 申請タブを開いたら、フレンド申請の未読をクリア
        clearFriendRequestUnread();
    }
    loadUserList(); 
};

// フレンド申請の未読をクリアする関数
function clearFriendRequestUnread() {
    // friend_request_で始まるキーを全て削除
    Object.keys(unreadRooms).forEach(key => {
        if(key.startsWith('friend_request_')) {
            delete unreadRooms[key];
        }
    });
    recalculateTotalUnread();
    console.log("Cleared friend request notifications");
}
window.loadUserList = () => {
    onSnapshot(collection(db, "friendRequests"), (reqSnap) => {
        const reqMap = {}; 
        let pendingRequestCount = 0;
        
        reqSnap.forEach(d => {
            reqMap[d.id] = d.data();
            // 自分宛ての未承認申請をカウント
            const data = d.data();
            if (data.to === auth.currentUser.uid && data.status === "pending") {
                pendingRequestCount++;
            }
        });
        
        // 申請タブのバッジを更新
        const $badge = $("#request-count-badge");
        if (pendingRequestCount > 0) {
            $badge.text(pendingRequestCount).show();
        } else {
            $badge.hide();
        }
        
        onSnapshot(collection(db, "users"), (userSnap) => {
            const $list = $("#user-list-container").empty();
            
            // 「申請」タブの場合
            if (currentTab === 'requests') {
                let hasRequests = false;
                
                // 受信した申請を表示
                $list.append('<div style="padding:10px; font-weight:bold; color:var(--txt-m); font-size:12px; border-bottom:1px solid var(--bg-38);">受信した申請</div>');
                Object.entries(reqMap).forEach(([reqId, reqData]) => {
                    if (reqData.to === auth.currentUser.uid && reqData.status === "pending") {
                        hasRequests = true;
                        const senderDoc = userSnap.docs.find(doc => doc.id === reqData.from);
                        if (senderDoc) {
                            const d = senderDoc.data();
                            const uid = senderDoc.id;
                            const safeName = escapeHTML(d.name || "ゲスト");
                            const isOnline = d.status === "online";
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
                
                // 送信した申請を表示
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
                            const isOnline = d.status === "online";
                            
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
                
                return; // 申請タブの処理はここで終了
            }
            
            // 「すべて」「フレンド」タブの処理（既存のロジック）
            userSnap.forEach((uDoc) => {
                const uid = uDoc.id; if (uid === auth.currentUser.uid) return;
                const d = uDoc.data();
                
                // 匿名ユーザーまたは「ゲスト」という名前のユーザーを除外
                if (d.isAnonymous === true) return;
                if (d.name === "ゲスト") return;
                
                const isOnline = d.status === "online"; const reqId = [auth.currentUser.uid, uid].sort().join("_"); const req = reqMap[reqId];
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
    // ゲストユーザーは申請できない
    if (auth.currentUser.isAnonymous || auth.currentUser.displayName === "ゲスト") {
        alert("フレンド機能を使うには、メールアドレスでログインしてください。\n\n右上のメニュー → ログアウト → メールでログイン");
        return;
    }
    const id = [auth.currentUser.uid, uid].sort().join("_"); 
    await setDoc(doc(db, "friendRequests", id), { from: auth.currentUser.uid, to: uid, status: "pending" }); 
};
window.acceptRequest = async (id) => { await updateDoc(doc(db, "friendRequests", id), { status: "accepted" }); };
window.removeFriend = async (id) => { if (confirm("解除しますか？")) await deleteDoc(doc(db, "friendRequests", id)); };

async function setupWebRTC() {
    pc = new RTCPeerConnection(servers);
    localStream = await navigator.mediaDevices.getUserMedia({ video: true, audio: true });
    localStream.getTracks().forEach(t => pc.addTrack(t, localStream));
    $("#localVideo")[0].srcObject = localStream;
    pc.ontrack = (e) => { $("#remoteVideo")[0].srcObject = e.streams[0]; };
    $("#call-overlay").removeClass("hidden");
}
window.startCall = async () => {
    $("#other-settings-modal").addClass("hidden"); await setupWebRTC();
    const callDoc = doc(collection(db, "calls")); currentCallId = callDoc.id;
    const offer = await pc.createOffer(); await pc.setLocalDescription(offer);
    await setDoc(callDoc, { offer: { type: offer.type, sdp: offer.sdp }, caller: auth.currentUser.displayName });
    onSnapshot(callDoc, (s) => { if (!pc.currentRemoteDescription && s.data()?.answer) pc.setRemoteDescription(new RTCSessionDescription(s.data().answer)); });
};
function listenForCalls() {
    onSnapshot(collection(db, "calls"), (snap) => {
        snap.docChanges().forEach(async (change) => {
            const data = change.doc.data();
            if (change.type === "added" && data.offer && !data.answer && data.caller !== auth.currentUser.displayName) {
                currentCallId = change.doc.id; await setupWebRTC();
                await pc.setRemoteDescription(new RTCSessionDescription(data.offer));
                const answer = await pc.createAnswer(); await pc.setLocalDescription(answer);
                await updateDoc(doc(db, "calls", currentCallId), { answer: { type: answer.type, sdp: answer.sdp } });
            }
        });
    });
}
let currentOnlineStatus = null; // 現在のステータスを記録（null, 'online', 'offline'）

// ===== Realtime Database プレゼンス管理 =====
// onDisconnectでサーバー側から確実にofflineにする
let presenceInitialized = false;

const initPresence = (uid) => {
    if (presenceInitialized) return;
    presenceInitialized = true;

    const statusRef = rtdbRef(rtdb, `status/${uid}`);
    const connectedRef = rtdbRef(rtdb, '.info/connected');

    onValue(connectedRef, async (snap) => {
        if (!snap.val()) return; // 切断中

        // 切断時にサーバーが自動でofflineにセット（これがポイント）
        await onDisconnect(statusRef).set({
            state: 'offline',
            lastSeen: rtdbServerTimestamp()
        });

        // 接続中はonlineにセット
        await rtdbSet(statusRef, {
            state: 'online',
            lastSeen: rtdbServerTimestamp()
        });

        // Firestoreにも同期
        updateDoc(doc(db, "users", uid), { status: "online", lastSeen: serverTimestamp() }).catch(() => {});
        currentOnlineStatus = 'online';
    });

    // RTDBのstatus変化をFirestoreに同期
    onValue(statusRef, (snap) => {
        if (!snap.val()) return;
        const state = snap.val().state;
        updateDoc(doc(db, "users", uid), {
            status: state,
            lastSeen: serverTimestamp()
        }).catch(() => {});
        currentOnlineStatus = state;
    });
};

const setOnline = async () => {
    if (!auth.currentUser) return;
    initPresence(auth.currentUser.uid);
    // RTDBがメインなので追加でFirestoreに書くだけ
    if (currentOnlineStatus !== 'online') {
        currentOnlineStatus = 'online';
        try {
            await rtdbSet(rtdbRef(rtdb, `status/${auth.currentUser.uid}`), {
                state: 'online', lastSeen: rtdbServerTimestamp()
            });
        } catch (e) {}
    }
};

const setOffline = async () => {
    if (!auth.currentUser) return;
    currentOnlineStatus = 'offline';
    try {
        await rtdbSet(rtdbRef(rtdb, `status/${auth.currentUser.uid}`), {
            state: 'offline', lastSeen: rtdbServerTimestamp()
        });
        await updateDoc(doc(db, "users", auth.currentUser.uid), {
            status: "offline", lastSeen: serverTimestamp(), isTyping: false
        });
    } catch (e) {}
};

$("#loginBtn").on("click", async () => {
    const e = $("#email").val(), p = $("#password").val();
    try { await signInWithEmailAndPassword(auth, e, p); }
    catch { const res = await createUserWithEmailAndPassword(auth, e, p); await setDoc(doc(db, "users", res.user.uid), { name: "ゲスト", photo: DEFAULT_AVATAR, status: "online", isTyping: false, isAnonymous: false }); }
    location.reload();
});

$("#guestBtn").on("click", async () => {
    try { await signInAnonymously(auth); location.reload(); }
    catch (e) { alert("ゲストログインエラー: " + e.message); }
});

const doLogout = async () => { 
    await setOffline();
    signOut(auth).then(() => location.reload()); 
};

$("#logoutBtn, #logoutBtnSide").on("click", doLogout);
$("#openOtherSettings").on("click", () => $("#other-settings-modal").removeClass("hidden"));

// --- イベント監視: 未読クリアのみ（オンライン状態はRTDB onDisconnectが管理） ---

// タブ表示復帰時に未読クリア
document.addEventListener("visibilitychange", () => {
    if (document.visibilityState === "visible" && document.hasFocus()) {
        clearUnread();
    }
}, true);

// フォーカス時に未読クリア
window.addEventListener("focus", () => { clearUnread(); });

// ユーザーアクションで未読クリア
window.addEventListener("mousemove", () => { if (document.hasFocus()) clearUnread(); });
window.addEventListener("click", () => { clearUnread(); });
window.addEventListener("keydown", () => { clearUnread(); });

// タッチイベント（モバイル）
let lastTouchTime = 0;
window.addEventListener("touchstart", () => {
    const now = Date.now();
    if (now - lastTouchTime > 100) { clearUnread(); lastTouchTime = now; }
}, { passive: true });

// ============================================================
// スマホ長押しコンテキストメニュー
// ============================================================
(function() {
    // メニューとオーバーレイをbodyに追加
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

        // リアクションデータをop-btnから取得（既存のonclick属性から流用）
        const reactionBtn = msgEl.querySelector('.op-btn[title="リアクション"]');

        let items = [];

        // リアクション
        items.push(`<div class="ctx-item" data-action="reaction">
            <span class="material-symbols-outlined">add_reaction</span> リアクション
        </div>`);

        // 返信
        const replyLabel = isStamp ? 'スタンプ' : (text || '画像');
        items.push(`<div class="ctx-item" data-action="reply" data-id="${id}" data-name="${name}" data-text="${replyLabel}">
            <span class="material-symbols-outlined">reply</span> 返信
        </div>`);

        // 編集（自分のメッセージかつスタンプでない場合）
        if (isMe && !isStamp) {
            items.push(`<div class="ctx-item" data-action="edit" data-id="${id}" data-text="${text}">
                <span class="material-symbols-outlined">edit</span> 編集
            </div>`);
        }

        // 削除（自分のメッセージ）
        if (isMe) {
            items.push(`<div class="ctx-item danger" data-action="delete" data-id="${id}">
                <span class="material-symbols-outlined">delete</span> 削除
            </div>`);
        }

        menuEl.innerHTML = items.join('');
        menuEl.classList.remove('hidden');
        overlayEl.classList.remove('hidden');

        // 位置調整（画面外に出ないように）
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

        // アイテムのクリックイベント
        menuEl.querySelectorAll('.ctx-item').forEach(item => {
            item.addEventListener('click', function() {
                const action = this.dataset.action;
                const _id   = this.dataset.id || id;
                if (action === 'reaction') {
                    // リアクションピッカーを開く（既存関数流用）
                    const fakeEvent = { clientX: px, clientY: py, target: menuEl, stopPropagation: () => {} };
                    // reactions情報はop-btnから取得できないためmsgElから取得
                    const existingReactions = {};
                    msgEl.querySelectorAll('.reaction-badge').forEach(b => {
                        const parts = b.textContent.trim().split(' ');
                        if (parts.length === 2) existingReactions[parts[0]] = [];
                    });
                    if (typeof window.openReactionPicker === 'function') {
                        window.openReactionPicker(id, fakeEvent, existingReactions);
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

    // イベント委譲: #messages上のタッチを監視
    document.addEventListener('touchstart', function(e) {
        if (!isMobile()) return;
        const msgEl = e.target.closest('.message');
        if (!msgEl) return;
        // アイコンクリックや既存ボタンは除外
        if (e.target.closest('.icon-container, .op-btn, .reaction-badge, .reply-in-bubble, .sent-img, .stamp-display')) return;

        targetMsg = msgEl;
        pressTimer = setTimeout(() => {
            if (targetMsg) {
                // 長押し振動フィードバック
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
})();

// ============================================================
// 通話ボタン（DM中のみ表示）
// ============================================================
$('#callDMBtn').on('click', async () => {
    if (!currentDMOtherUid) return;
    // 既存のWebRTC通話を発信
    $('#other-settings-modal').addClass('hidden');
    await setupWebRTC();
    const callDoc = doc(collection(db, "calls"));
    currentCallId = callDoc.id;
    const offer = await pc.createOffer();
    await pc.setLocalDescription(offer);
    await setDoc(callDoc, {
        offer: { type: offer.type, sdp: offer.sdp },
        caller: auth.currentUser.displayName,
        callerUid: auth.currentUser.uid,
        targetUid: currentDMOtherUid
    });
    onSnapshot(callDoc, (s) => {
        if (!pc.currentRemoteDescription && s.data()?.answer)
            pc.setRemoteDescription(new RTCSessionDescription(s.data().answer));
    });
});

// ============================================================
// ランキング
// ============================================================
$('#openRankingBtn').on('click', () => {
    $('#ranking-modal').removeClass('hidden');
    loadRanking('coins');
});

$('#openStockBtn').on('click', async () => {
    $('#stock-modal').removeClass('hidden');
    await initStockData();
});

window.switchRankTab = (tab, el) => {
    $('.rank-tab-btn').css({ background: 'var(--bg-38)', color: 'var(--txt)' });
    $(el).css({ background: 'var(--accent)', color: '#fff' });
    loadRanking(tab);
};

async function loadRanking(tab) {
    const $list = $('#ranking-list').html('<div style="text-align:center; padding:20px; color:var(--txt-m);">読み込み中...</div>');
    try {
        const snap = await getDocs(collection(db, "users"));
        let users = snap.docs.map(d => ({ uid: d.id, ...d.data() })).filter(u => u.name);

        if (tab === 'coins') {
            users.sort((a, b) => (b.coins || 0) - (a.coins || 0));
        } else {
            // 株資産 = 保有数 × 現在株価
            const priceSnap = await getDocs(collection(db, "stocks"));
            const prices = {};
            priceSnap.docs.forEach(d => { prices[d.id] = d.data().price || 0; });
            users.forEach(u => {
                let val = 0;
                const holdings = u.stockHoldings || {};
                Object.entries(holdings).forEach(([sym, qty]) => { val += (prices[sym] || 0) * qty; });
                u._stockVal = val;
            });
            users.sort((a, b) => (b._stockVal || 0) - (a._stockVal || 0));
        }

        const medals = ['🥇', '🥈', '🥉'];
        $list.empty();
        users.slice(0, 20).forEach((u, i) => {
            const rank = i < 3 ? medals[i] : `${i + 1}`;
            const value = tab === 'coins'
                ? `💰 ${(u.coins || 0).toLocaleString()}`
                : `📊 ${(u._stockVal || 0).toLocaleString()}`;
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

// ============================================================
// 株ゲーム（倒産・IPOサイクル対応）
// ============================================================

// 銘柄タイプの表示設定
const STOCK_TYPE_LABELS = {
    stable:   { label: '安定型',     color: '#26c6da', icon: '🏦' },
    growth:   { label: '成長型',     color: '#00c853', icon: '📈' },
    highRisk: { label: 'ハイリスク', color: '#ff4757', icon: '⚠️' },
    meme:     { label: 'ミーム',     color: '#f093fb', icon: '🎰' },
    cycle:    { label: '循環型',     color: '#ffd700', icon: '🔄' },
    rare:     { label: '希少型',     color: '#a78bfa', icon: '💎' },
};

let activeStockIds  = [];  // 現在上場中のID一覧
let stockData       = {};  // { id: {name,price,history,...} }
let stockPrices     = {};  // { id: 現在価格 }
let stockHistory    = {};  // { id: 価格履歴 }
let stockEvents     = {};  // { id: 直近イベント }
let userCoinsCache  = 0;
let userHoldings    = {};
let stockListeners  = [];

// ===== Firestore購読 =====
function subscribeStocks() {
    stockListeners.forEach(u => u());
    stockListeners = [];

    // __list__を購読してactiveIdsを取得
    const listUnsub = onSnapshot(doc(db, "stocks", "stock_list"), async (listSnap) => {
        if (!listSnap.exists()) return;
        const newIds = listSnap.data().activeIds || [];

        // 新たに追加されたIDを購読
        newIds.forEach(id => {
            if (!activeStockIds.includes(id)) {
                const unsub = onSnapshot(doc(db, "stocks", id), (snap) => {
                    if (!snap.exists()) return;
                    const d = snap.data();
                    stockData[id] = d;
                    stockPrices[id]  = d.price;
                    stockHistory[id] = d.history || [];
                    stockEvents[id]  = d.lastEvent || '';

                    if (!$('#stock-modal').hasClass('hidden')) {
                        // 上場廃止チェック
                        if (d.status === 'delisted') {
                            handleDelisted(id, d);
                        } else {
                            refreshStockCard(id);
                            refreshPortfolio();
                        }
                    }
                });
                stockListeners.push(unsub);
            }
        });

        // 上場廃止で消えたIDを検知
        activeStockIds.forEach(id => {
            if (!newIds.includes(id)) {
                // リストから消えた→上場廃止済み
                if (userHoldings[id]) {
                    showDelistNotice(id, stockData[id]?.name || id);
                    delete userHoldings[id];
                }
                $(`#stock-card-${id}`).remove();
                delete stockData[id];
            }
        });

        activeStockIds = [...newIds];

        if (!$('#stock-modal').hasClass('hidden')) {
            renderStockList();
        }
    });
    stockListeners.push(listUnsub);
}

function handleDelisted(id, d) {
    if (userHoldings[id] && userHoldings[id] > 0) {
        showDelistNotice(id, d.name);
        userHoldings[id] = 0;
        delete userHoldings[id];
        // Firestoreにも反映
        updateDoc(doc(db, "users", auth.currentUser.uid), {
            stockHoldings: userHoldings
        }).catch(() => {});
    }
    $(`#stock-card-${id}`).html(`
        <div style="background:rgba(255,71,87,0.1); border:1px solid #ff4757; border-radius:12px; padding:14px; text-align:center; opacity:0.6;">
            <div style="font-size:20px; margin-bottom:6px;">💀 上場廃止</div>
            <div style="font-size:13px; color:var(--txt-m);">${d.name}</div>
        </div>
    `);
}

function showDelistNotice(id, name) {
    const $notice = $(`<div style="position:fixed; top:80px; left:50%; transform:translateX(-50%); background:#ff4757; color:#fff; padding:12px 24px; border-radius:10px; font-weight:bold; z-index:9999; font-size:14px; box-shadow:0 4px 20px rgba(255,71,87,0.5);">💀 ${name} が上場廃止！保有株が紙切れになりました</div>`);
    $('body').append($notice);
    setTimeout(() => $notice.fadeOut(500, () => $notice.remove()), 4000);
}

// ===== 株画面初期化 =====
async function initStockData() {
    const userSnap = await getDoc(doc(db, "users", auth.currentUser.uid));
    const userData = userSnap.data() || {};
    userCoinsCache = userData.coins || 0;
    userHoldings   = { ...(userData.stockHoldings || {}) };

    // __list__を取得
    const listSnap = await getDoc(doc(db, "stocks", "stock_list"));
    if (!listSnap.exists()) {
        $('#stock-list').html('<div style="text-align:center; padding:40px; color:var(--txt-m);">初期化中... 少し待ってください</div>');
        return;
    }

    activeStockIds = listSnap.data().activeIds || [];

    // 各銘柄のデータ取得
    for (const id of activeStockIds) {
        const snap = await getDoc(doc(db, "stocks", id));
        if (!snap.exists()) continue;
        const d = snap.data();
        stockData[id]    = d;
        stockPrices[id]  = d.price;
        stockHistory[id] = d.history || [];
        stockEvents[id]  = d.lastEvent || '';
    }

    renderStockList();
    refreshPortfolio();

    // リアルタイム購読（初回のみ開始）
    if (stockListeners.length === 0) {
        subscribeStocks();
    }
}

// ===== カード一覧描画 =====
function renderStockList() {
    const $list = $('#stock-list').empty();
    activeStockIds.forEach(id => {
        $list.append(`<div id="stock-card-${id}"></div>`);
        refreshStockCard(id);
    });
}

function refreshStockCard(stockId) {
    const d = stockData[stockId];
    if (!d) return;
    if (d.status === 'delisted') { handleDelisted(stockId, d); return; }

    const price    = d.price || 1;
    const ipoPrice = d.ipoPrice || price;
    const hist     = d.history || [];
    const event    = d.lastEvent || '';
    const inCrisis = d.inCrisis || false;
    const typeConf = STOCK_TYPE_LABELS[d.stockType] || STOCK_TYPE_LABELS.highRisk;

    // 前回比
    const prevPrice = hist.length >= 2 ? hist[hist.length - 2].price : ipoPrice;
    const changePct = ((price - prevPrice) / prevPrice * 100).toFixed(1);
    const up        = price >= prevPrice;
    const changeColor = up ? '#00c853' : '#ff4757';
    const changeSign  = up ? '▲' : '▼';

    // IPO比
    const ipoChange = ((price - ipoPrice) / ipoPrice * 100).toFixed(1);
    const ipoColor  = price >= ipoPrice ? '#00c853' : '#ff4757';

    // スパークライン
    let sparkSvg = '';
    const pts = hist.slice(-30);
    if (pts.length >= 2) {
        const prices = pts.map(p => p.price);
        const mn = Math.min(...prices), mx = Math.max(...prices);
        const range = mx - mn || 1;
        const coords = pts.map((p, i) => {
            const x = (i / (pts.length - 1)) * 200;
            const y = 50 - ((p.price - mn) / range) * 44 - 3;
            return `${x.toFixed(1)},${y.toFixed(1)}`;
        }).join(' ');
        sparkSvg = `<svg width="200" height="50" viewBox="0 0 200 50" style="display:block;margin:8px 0 4px;">
            <polyline points="${coords}" fill="none" stroke="${up ? '#00c853' : '#ff4757'}" stroke-width="2" stroke-linejoin="round"/>
        </svg>`;
    }

    const owned = userHoldings[stockId] || 0;
    const crisisBorder = inCrisis ? 'border:2px solid #ff4757;' : 'border:1px solid rgba(255,255,255,0.06);';
    const crisisBg     = inCrisis ? 'background:rgba(255,71,87,0.08);' : 'background:var(--bg-38);';

    const card = `
        <div style="${crisisBg} border-radius:12px; padding:14px; ${crisisBorder}">
            <div style="display:flex; justify-content:space-between; align-items:flex-start; margin-bottom:4px;">
                <div style="min-width:0; flex:1;">
                    <div style="font-weight:bold; font-size:15px; margin-bottom:2px;">${d.name}</div>
                    <div style="display:flex; gap:6px; align-items:center; flex-wrap:wrap;">
                        <span style="font-size:10px; background:${typeConf.color}22; color:${typeConf.color}; border-radius:4px; padding:1px 6px; font-weight:bold;">${typeConf.icon} ${typeConf.label}</span>
                        ${inCrisis ? '<span style="font-size:10px; background:rgba(255,71,87,0.2); color:#ff4757; border-radius:4px; padding:1px 6px; font-weight:bold; animation:badgePulse 1s infinite;">⚠️ 倒産危機</span>' : ''}
                        <span style="font-size:10px; color:var(--txt-m);">保有: ${owned}株</span>
                    </div>
                </div>
                <div style="text-align:right; flex-shrink:0; margin-left:10px;">
                    <div style="font-size:20px; font-weight:bold; color:#ffd700;">${price.toLocaleString()} 💰</div>
                    <div style="font-size:12px; color:${changeColor}; font-weight:bold;">${changeSign} ${Math.abs(changePct)}%</div>
                    <div style="font-size:10px; color:${ipoColor};">IPO比 ${price >= ipoPrice ? '+' : ''}${ipoChange}%</div>
                </div>
            </div>
            ${event ? `<div style="font-size:12px; color:${changeColor}; font-weight:bold; margin:2px 0;">${event}</div>` : ''}
            ${sparkSvg}
            <div style="display:flex; align-items:center; gap:6px; margin-bottom:8px;">
                <button onclick="adjustStockQty('${stockId}',-1)" class="stock-qty-btn">−</button>
                <input id="qty-${stockId}" type="number" value="1" min="1" max="99999" class="settings-input" style="flex:1; text-align:center; padding:5px; font-size:14px; font-weight:bold; margin-bottom:0;">
                <button onclick="adjustStockQty('${stockId}',1)" class="stock-qty-btn">＋</button>
                <button onclick="setStockQtyMax('${stockId}','buy')" class="stock-max-btn">全力買</button>
                <button onclick="setStockQtyMax('${stockId}','sell')" class="stock-max-btn">全売</button>
            </div>
            <div style="display:flex; gap:8px;">
                <button onclick="tradeStockQty('${stockId}','buy')" style="flex:1; padding:10px; background:#00c853; color:#fff; border:none; border-radius:6px; cursor:pointer; font-weight:bold; font-size:14px;">📈 買う</button>
                <button onclick="tradeStockQty('${stockId}','sell')" id="sell-btn-${stockId}" style="flex:1; padding:10px; background:#ff4757; color:#fff; border:none; border-radius:6px; cursor:pointer; font-weight:bold; font-size:14px;" ${owned < 1 ? 'disabled style="opacity:0.4"' : ''}>📉 売る</button>
            </div>
        </div>`;
    $(`#stock-card-${stockId}`).html(card);
}

window.tradeStock = async (stockId, action, qty) => {
    const userRef = doc(db, "users", auth.currentUser.uid);
    const userSnap = await getDoc(userRef);
    const userData = userSnap.data();
    let coins = userData.coins || 0;
    const holdings = { ...(userData.stockHoldings || {}) };

    // onSnapshotで常に最新を保持しているstockPricesを使用
    const price = stockPrices[stockId] || STOCKS.find(s => s.id === stockId)?.basePrice || 100;
    const cost = price * qty;
    const owned = holdings[stockId] || 0;

    if (action === 'buy') {
        if (coins < cost) { alert(`💰 コインが足りません（必要: ${cost.toLocaleString()}）`); return; }
        coins -= cost;
        holdings[stockId] = owned + qty;
    } else {
        if (owned < qty) { alert(`株が足りません（保有: ${owned}株）`); return; }
        coins += cost;
        holdings[stockId] = owned - qty;
        if (holdings[stockId] <= 0) delete holdings[stockId];
    }

    // updateDocで完全上書き（setDoc+mergeだとマップのキー削除が反映されない）
    await updateDoc(userRef, { coins, stockHoldings: holdings });
    userHoldings = { ...holdings }; // キャッシュ更新
    refreshPortfolio(coins, holdings); // ローカルで即計算
    refreshStockCard(stockId, holdings);
};
