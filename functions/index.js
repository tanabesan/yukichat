const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getAuth } = require("firebase-admin/auth");

initializeApp();

// クライアント側(app.js)のADMIN_EMAILSと必ず同じ内容にしてください。
// どちらか片方だけ更新すると、管理者権限の判定がズレて事故のもとになります。
const ADMIN_EMAILS = ["arinkodayo0204@gmail.com"];

function assertIsAdmin(request) {
    if (!request.auth) {
        throw new HttpsError("unauthenticated", "ログインしてください");
    }
    const callerEmail = request.auth.token.email;
    if (!callerEmail || !ADMIN_EMAILS.includes(callerEmail)) {
        throw new HttpsError("permission-denied", "管理者のみ実行できます");
    }
}

// 管理者パネルから呼び出す：指定したUIDのユーザーをメール認証済み扱いにする。
// 認証メールが届かない等でログインできなくなったユーザーを、管理者が手動で救済するためのもの。
exports.adminVerifyUserEmail = onCall(async (request) => {
    assertIsAdmin(request);

    const targetUid = (request.data && request.data.uid || "").trim();
    if (!targetUid) {
        throw new HttpsError("invalid-argument", "uidを指定してください");
    }

    try {
        const userRecord = await getAuth().getUser(targetUid);
        if (userRecord.emailVerified) {
            return { success: true, alreadyVerified: true, email: userRecord.email };
        }
        await getAuth().updateUser(targetUid, { emailVerified: true });
        return { success: true, alreadyVerified: false, email: userRecord.email };
    } catch (err) {
        if (err.code === "auth/user-not-found") {
            throw new HttpsError("not-found", "指定されたUIDのユーザーが見つかりません");
        }
        throw new HttpsError("internal", "エラー: " + err.message);
    }
});
