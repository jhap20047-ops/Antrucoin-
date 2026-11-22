// Cloud Functions for Antru Wallet (requires Blaze plan to deploy)
// Setup: cd functions && npm init -y && npm i firebase-functions firebase-admin
const { onCall, HttpsError } = require("firebase-functions/v2/https");
const { initializeApp } = require("firebase-admin/app");
const { getFirestore, FieldValue } = require("firebase-admin/firestore");

initializeApp();
const db = getFirestore();

// Atomic user-to-user transfer by Antru ID
exports.transferCoins = onCall(async (req) => {
  if (!req.auth) throw new HttpsError("unauthenticated", "Pehle login karein.");

  const toAntruId = String(req.data?.toAntruId || "").trim().toUpperCase();
  const amount = Number(req.data?.amount);
  if (!toAntruId) throw new HttpsError("invalid-argument", "Recipient ID daalein.");
  if (!Number.isInteger(amount) || amount < 1) throw new HttpsError("invalid-argument", "Invalid amount.");

  const fromUid = req.auth.uid;

  await db.runTransaction(async (tx) => {
    const idSnap = await tx.get(db.collection("antruIds").doc(toAntruId));
    if (!idSnap.exists) throw new HttpsError("not-found", "Recipient ID nahi mila.");
    const toUid = idSnap.data().uid;
    if (toUid === fromUid) throw new HttpsError("invalid-argument", "Khud ko transfer nahi kar sakte.");

    const fromRef = db.collection("users").doc(fromUid);
    const toRef = db.collection("users").doc(toUid);
    const [fromSnap, toSnap] = await Promise.all([tx.get(fromRef), tx.get(toRef)]);

    const fromBal = fromSnap.data().balance || 0;
    if (fromBal < amount) throw new HttpsError("failed-precondition", "Balance kam hai.");

    tx.update(fromRef, { balance: fromBal - amount });
    tx.update(toRef, { balance: (toSnap.data().balance || 0) + amount });

    const now = FieldValue.serverTimestamp();
    tx.set(db.collection("transactions").doc(), {
      uid: fromUid, title: "Sent to " + toAntruId, amount: -amount, createdAt: now
    });
    tx.set(db.collection("transactions").doc(), {
      uid: toUid, title: "Received from " + fromSnap.data().antruId, amount, createdAt: now
    });
  });

  return { ok: true };
});
