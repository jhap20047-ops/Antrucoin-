const {onCall,HttpsError}=require("firebase-functions/v2/https");
const {onDocumentCreated}=require("firebase-functions/v2/firestore");
const {defineSecret}=require("firebase-functions/params");
const admin=require("firebase-admin");
const nodemailer=require("nodemailer");
admin.initializeApp();
const db=admin.firestore();
const MAIL_USER=defineSecret("MAIL_USER");
const MAIL_PASS=defineSecret("MAIL_PASS");
const otpStore=db.collection("_emailOtps");

exports.sendEmailOtp=onCall({secrets:[MAIL_USER,MAIL_PASS]},async(req)=>{
  const email=String(req.data.email||"").trim().toLowerCase();
  if(!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email))throw new HttpsError("invalid-argument","Valid email required.");
  const otp=String(Math.floor(100000+Math.random()*900000));
  const ref=otpStore.doc(Buffer.from(email).toString("base64url"));
  await ref.set({otp,expiresAt:Date.now()+5*60*1000,attempts:0,createdAt:Date.now()});
  const transporter=nodemailer.createTransport({service:"gmail",auth:{user:MAIL_USER.value(),pass:MAIL_PASS.value()}});
  await transporter.sendMail({from:`Antru Wallet <${MAIL_USER.value()}>`,to:email,subject:"Your Antru verification code",text:`Your Antru OTP is ${otp}. It expires in 5 minutes. Do not share it.`});
  return {message:"6-digit OTP sent. Check your inbox."};
});
exports.verifyEmailOtp=onCall(async(req)=>{
  const email=String(req.data.email||"").trim().toLowerCase(),otp=String(req.data.otp||"").trim();
  const ref=otpStore.doc(Buffer.from(email).toString("base64url"));
  const snap=await ref.get();if(!snap.exists)throw new HttpsError("not-found","OTP request not found.");
  const d=snap.data();if(Date.now()>d.expiresAt)throw new HttpsError("deadline-exceeded","OTP expired.");
  if(d.attempts>=5)throw new HttpsError("resource-exhausted","Too many attempts.");
  if(otp!==d.otp){await ref.update({attempts:admin.firestore.FieldValue.increment(1)});throw new HttpsError("permission-denied","Incorrect OTP.");}
  await ref.delete();
  // This verifies the email OTP only. A production identity flow must mint a Firebase custom token
  // via Admin SDK and sign in with signInWithCustomToken on the client.
  return {verified:true,email};
});
exports.createProfile=onCall(async(req)=>{
  if(!req.auth)throw new HttpsError("unauthenticated","Sign in first.");
  const uid=req.auth.uid;
  const name=String(req.data?.name||"").trim();
  const age=Number(req.data?.age);
  const rawMobile=String(req.data?.mobile||"").trim();
  const mobile=rawMobile.replace(/[\s()-]/g,"");
  if(name.length<2||name.length>50)throw new HttpsError("invalid-argument","Enter a valid full name.");
  if(!Number.isInteger(age)||age<13||age>120)throw new HttpsError("invalid-argument","Enter a valid age.");
  if(!/^\+[1-9]\d{7,14}$/.test(mobile))throw new HttpsError("invalid-argument","Enter a valid mobile number with country code.");

  const userRef=db.doc(`users/${uid}`);
  const walletRef=db.doc(`wallets/${uid}`);
  try{
    return await db.runTransaction(async(tx)=>{
      const existing=await tx.get(userRef);
      if(existing.exists)return existing.data();

      const wallet=await tx.get(walletRef);
      const antruId="ANTRU-"+uid.slice(0,10).toUpperCase();
      const profile={
        uid,antruId,name,age,mobile,
        createdAt:admin.firestore.FieldValue.serverTimestamp()
      };
      tx.set(userRef,profile);
      if(!wallet.exists){
        tx.set(walletRef,{
          uid,balance:0,
          updatedAt:admin.firestore.FieldValue.serverTimestamp()
        });
      }
      return {
        uid,antruId,name,age,mobile,
        createdAt:admin.firestore.Timestamp.now()
      };
    });
  }catch(error){
    console.error("createProfile transaction failed",{
      uid,code:error?.code,message:error?.message,stack:error?.stack
    });
    if(error instanceof HttpsError)throw error;
    throw new HttpsError(
      "internal",
      "Profile creation failed on the server. Confirm Firestore Database is created and review the createProfile Cloud Function logs."
    );
  }
});
exports.requestTopup=onCall(async(req)=>{
  if(!req.auth)throw new HttpsError("unauthenticated","Sign in first.");
  const amount=Number(req.data.amount);if(!Number.isInteger(amount)||amount<1||amount>100000)throw new HttpsError("invalid-argument","Invalid amount.");
  const ref=db.collection("topupRequests").doc();
  await ref.set({uid:req.auth.uid,amount,status:"pending",createdAt:admin.firestore.FieldValue.serverTimestamp()});
  return {message:"Demo top-up request submitted for admin review."};
});
exports.transferCoins=onCall(async(req)=>{
  if(!req.auth)throw new HttpsError("unauthenticated","Sign in first.");
  const uid=req.auth.uid,receiverId=String(req.data.receiverId||""),amount=Number(req.data.amount);
  if(!Number.isInteger(amount)||amount<1||amount>100000)throw new HttpsError("invalid-argument","Invalid amount.");
  const match=await db.collection("users").where("antruId","==",receiverId).limit(1).get();
  if(match.empty)throw new HttpsError("not-found","Receiver not found.");
  const receiverUid=match.docs[0].id;if(receiverUid===uid)throw new HttpsError("failed-precondition","Cannot send coins to yourself.");
  const senderWallet=db.doc(`wallets/${uid}`),receiverWallet=db.doc(`wallets/${receiverUid}`),txRef=db.collection("transactions").doc();
  await db.runTransaction(async(t)=>{
    const s=await t.get(senderWallet),r=await t.get(receiverWallet);
    if(!s.exists||!r.exists)throw new HttpsError("not-found","Wallet not found.");
    if(Number(s.data().balance||0)<amount)throw new HttpsError("failed-precondition","Insufficient demo balance.");
    t.update(senderWallet,{balance:admin.firestore.FieldValue.increment(-amount),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
    t.update(receiverWallet,{balance:admin.firestore.FieldValue.increment(amount),updatedAt:admin.firestore.FieldValue.serverTimestamp()});
    t.set(txRef,{uid,receiverUid,type:"Coin transfer",amount,status:"completed",createdAt:admin.firestore.FieldValue.serverTimestamp()});
  });
  return {message:"Demo coin transfer completed."};
});
