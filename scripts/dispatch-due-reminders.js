const { initializeApp, cert } = require("firebase-admin/app");
const { FieldValue, getFirestore, Timestamp } = require("firebase-admin/firestore");
const { getMessaging } = require("firebase-admin/messaging");

const APP_ID = "meghbitan-homestay-app";
const REMINDER_LIMIT = 100;
const TEST_LIMIT = 100;
const PROCESSING_LEASE_MS = 4 * 60 * 1000;

function initializeFirebaseAdmin() {
    const serviceAccountJson = process.env.FIREBASE_SERVICE_ACCOUNT_JSON;
    if (!serviceAccountJson) throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is required.");

    let serviceAccount;
    try {
        serviceAccount = JSON.parse(serviceAccountJson);
    } catch (error) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is not valid JSON.", { cause: error });
    }

    if (!serviceAccount.project_id || !serviceAccount.client_email || !serviceAccount.private_key) {
        throw new Error("FIREBASE_SERVICE_ACCOUNT_JSON is missing required service-account fields.");
    }

    initializeApp({ credential: cert(serviceAccount) });
    return getFirestore();
}

function ownerCollection(db, uid, name) {
    return db.collection("artifacts").doc(APP_ID).collection("users").doc(uid).collection(name);
}

function parseOwnerUid(documentRef, collectionName) {
    const path = documentRef.path.split("/");
    const collectionIndex = collectionName === "reminders" ? 6 : 4;
    if (path.length !== collectionIndex + 2 || path[0] !== "artifacts" ||
        path[1] !== APP_ID || path[2] !== "users" || path[collectionIndex] !== collectionName) {
        throw new Error(`Unexpected ${collectionName} document path: ${documentRef.path}`);
    }
    return path[3];
}

function reminderMessage(data, reminderId) {
    const rooms = Array.isArray(data.roomIds) ? data.roomIds.join(", ") : "";
    return {
        data: {
            title: `Meghbitan arrival reminder: ${data.guestName || "Guest"}`,
            body: `${data.label || "Scheduled reminder"} • Check-in: ${data.checkIn || "upcoming"} • Rooms: ${rooms || "not specified"}`,
            reminderId
        }
    };
}

async function sendToOwnerDevices(db, uid, message) {
    const tokenSnapshot = await ownerCollection(db, uid, "deviceTokens").get();
    const tokenDocs = tokenSnapshot.docs;
    const tokens = tokenDocs.map((snapshot) => snapshot.get("token")).filter(Boolean);
    if (!tokens.length) return { sent: 0, failed: 0 };

    let sent = 0;
    let failed = 0;
    const invalidTokenDocuments = new Map();
    for (let start = 0; start < tokens.length; start += 500) {
        const chunk = tokens.slice(start, start + 500);
        const response = await getMessaging().sendEachForMulticast({ ...message, tokens: chunk });
        sent += response.successCount;
        response.responses.forEach((result, index) => {
            if (result.success) return;
            failed += 1;
            if ([
                "messaging/invalid-registration-token",
                "messaging/registration-token-not-registered"
            ].includes(result.error?.code)) {
                tokenDocs
                    .filter((snapshot) => snapshot.get("token") === chunk[index])
                    .forEach((snapshot) => invalidTokenDocuments.set(snapshot.ref.path, snapshot));
            } else {
                console.error("FCM delivery failed:", result.error?.code || "unknown error");
            }
        });
    }
    await Promise.all(Array.from(invalidTokenDocuments.values(), (snapshot) => snapshot.ref.delete()));
    return { sent, failed };
}

async function claimDocument(db, documentRef) {
    return db.runTransaction(async (transaction) => {
        const snapshot = await transaction.get(documentRef);
        if (!snapshot.exists) return null;

        const data = snapshot.data();
        const now = Date.now();
        if (data.acknowledged || data.sentAt || data.status === "sent" ||
            (data.processingUntil instanceof Timestamp && data.processingUntil.toMillis() > now)) {
            return null;
        }

        transaction.update(documentRef, {
            processingUntil: Timestamp.fromMillis(now + PROCESSING_LEASE_MS)
        });
        return data;
    });
}

async function processReminder(db, reminderRef) {
    const data = await claimDocument(db, reminderRef);
    if (!data) return;

    try {
        const uid = data.ownerUid || parseOwnerUid(reminderRef, "reminders");
        const result = await sendToOwnerDevices(db, uid, reminderMessage(data, reminderRef.id));
        if (!result.sent || result.failed) {
            await reminderRef.update({
                attemptCount: FieldValue.increment(1),
                nextAttemptAt: Timestamp.fromMillis(Date.now() + (result.sent ? 2 : 15) * 60 * 1000),
                processingUntil: FieldValue.delete()
            });
            return;
        }

        await reminderRef.update({
            sentAt: FieldValue.serverTimestamp(),
            deliveryCount: result.sent,
            attemptCount: FieldValue.increment(1),
            processingUntil: FieldValue.delete()
        });
    } catch (error) {
        console.error(`Reminder delivery failed (${reminderRef.path}):`, error.message);
        await reminderRef.update({
            attemptCount: FieldValue.increment(1),
            nextAttemptAt: Timestamp.fromMillis(Date.now() + 2 * 60 * 1000),
            processingUntil: FieldValue.delete()
        });
    }
}

async function processPushTest(db, testRef) {
    const data = await claimDocument(db, testRef);
    if (!data) return;

    try {
        const uid = parseOwnerUid(testRef, "pushTests");
        const result = await sendToOwnerDevices(db, uid, {
            data: {
                title: "Meghbitan Homestay — Push test",
                body: "This device is connected to background booking reminders.",
                reminderId: testRef.id
            }
        });
        await testRef.update({
            status: result.sent ? "sent" : "no_devices",
            sentCount: result.sent,
            failedCount: result.failed,
            completedAt: FieldValue.serverTimestamp(),
            processingUntil: FieldValue.delete()
        });
    } catch (error) {
        console.error(`Push test failed (${testRef.path}):`, error.message);
        await testRef.update({
            status: "failed",
            error: error.message.slice(0, 500),
            completedAt: FieldValue.serverTimestamp(),
            processingUntil: FieldValue.delete()
        });
        throw error;
    }
}

async function main() {
    const db = initializeFirebaseAdmin();
    const now = Timestamp.now();
    const [reminders, pushTests] = await Promise.all([
        db.collectionGroup("reminders")
            .where("acknowledged", "==", false)
            .where("sentAt", "==", null)
            .where("dueAt", "<=", now)
            .where("nextAttemptAt", "<=", now)
            .orderBy("dueAt", "asc")
            .orderBy("nextAttemptAt", "asc")
            .limit(REMINDER_LIMIT)
            .get(),
        db.collectionGroup("pushTests")
            .where("status", "==", "pending")
            .orderBy("createdAt", "asc")
            .limit(TEST_LIMIT)
            .get()
    ]);

    const results = await Promise.allSettled([
        ...reminders.docs.map((snapshot) => processReminder(db, snapshot.ref)),
        ...pushTests.docs.map((snapshot) => processPushTest(db, snapshot.ref))
    ]);
    console.log(`Processed ${reminders.size} due reminder(s) and ${pushTests.size} push test(s).`);
    const failures = results.filter((result) => result.status === "rejected");
    if (failures.length) {
        throw new Error(`${failures.length} dispatch task(s) failed; see the logged errors above.`);
    }
}

main().catch((error) => {
    console.error("Scheduled reminder dispatch failed:", error);
    process.exitCode = 1;
});
