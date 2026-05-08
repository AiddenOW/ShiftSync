"use strict";

const {onDocumentCreated, onDocumentWritten} = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();
const messaging = admin.messaging();

/**
 * Récupère tous les tokens FCM sauf celui de l'expéditeur.
 * @param {string} excludeUserId - L'utilisateur à exclure.
 * @return {Promise<string[]>} Liste des tokens.
 */
async function getTokensExcept(excludeUserId) {
  const snap = await db.collection("fcmTokens").get();
  return snap.docs
    .map((d) => d.data())
    .filter((d) => d.userId !== excludeUserId)
    .map((d) => d.token)
    .filter(Boolean);
}

/**
 * Envoie des notifications push.
 * @param {string[]} tokens - Les tokens FCM.
 * @param {string} title - Titre.
 * @param {string} body - Corps.
 * @param {Object} data - Données.
 * @return {Promise<void>}
 */
async function sendNotifications(tokens, title, body, data = {}) {
  if (tokens.length === 0) return;

  const chunks = [];
  for (let i = 0; i < tokens.length; i += 500) {
    chunks.push(tokens.slice(i, i + 500));
  }

  for (const chunk of chunks) {
    const message = {
      notification: {title, body},
      data: {...data, title, body},
      webpush: {
        headers: {"Urgency": "high"},
        notification: {
          title,
          body,
          icon: "https://aiddenow.github.io/ShiftSync/icon-192.png",
          badge: "https://aiddenow.github.io/ShiftSync/icon-192.png",
          renotify: false,
          tag: "shiftsync-notif",
        },
        fcmOptions: {
          link: "https://aiddenow.github.io/ShiftSync/",
        },
      },
      apns: {
        headers: {"apns-priority": "10"},
        payload: {
          aps: {
            alert: {title, body},
            sound: "default",
            badge: 1,
            "content-available": 1,
          },
        },
      },
      tokens: chunk,
    };

    try {
      const result = await messaging.sendEachForMulticast(message);
      console.log(`Envoyé: ${result.successCount} ok, ${result.failureCount} échecs`);
      result.responses.forEach((resp, idx) => {
        if (!resp.success) {
          const code = resp.error && resp.error.code;
          if (
            code === "messaging/invalid-registration-token" ||
            code === "messaging/registration-token-not-registered"
          ) {
            db.collection("fcmTokens").doc(chunk[idx]).delete();
          }
        }
      });
    } catch (err) {
      console.error("Erreur envoi FCM :", err);
    }
  }
}

// Notification nouveau message chat
exports.onNewChatMessage = onDocumentCreated(
  {document: "chat/{messageId}", region: "europe-west1"},
  async (event) => {
    const message = event.data.data();
    if (!message || !message.text || !message.sender) return;

    const tokens = await getTokensExcept(message.sender);
    const title = `💬 ${message.sender}`;
    const body = message.text.length > 100
      ? message.text.substring(0, 97) + "..."
      : message.text;

    await sendNotifications(tokens, title, body, {type: "chat", sender: message.sender});
  }
);

// Notification modification d'horaire
exports.onScheduleChange = onDocumentWritten(
  {document: "exceptions/{dateString}", region: "europe-west1"},
  async (event) => {
    const dateString = event.params.dateString;
    const before = event.data.before.exists ? event.data.before.data() : {};
    const after = event.data.after.exists ? event.data.after.data() : {};

    let changedEmployee = null;
    for (const emp of Object.keys(after)) {
      if (after[emp] !== before[emp]) {
        changedEmployee = emp;
        break;
      }
    }
    if (!changedEmployee) return;

    const [year, month, day] = dateString.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    const dateFormatted = date.toLocaleDateString("fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });

    const newShift = after[changedEmployee] || "Horaire supprimé";
    const title = "🗓️ Planning modifié";
    const body = `${changedEmployee} — ${dateFormatted} : ${newShift}`;

    const tokens = await getTokensExcept(changedEmployee);
    await sendNotifications(tokens, title, body, {type: "schedule", date: dateString, sender: changedEmployee});
  }
);