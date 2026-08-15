"use strict";

const {onDocumentCreated, onDocumentWritten} = require("firebase-functions/v2/firestore");
const admin = require("firebase-admin");
admin.initializeApp();

const db = admin.firestore();
const messaging = admin.messaging();
const bucket = admin.storage().bucket();

const MAX_MESSAGES = 50;

/**
 * Recupere tous les tokens FCM sauf celui de l'expediteur.
 * @param {string} excludeUserId - L'utilisateur a exclure.
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
 * Recupere les tokens FCM pour une liste d'utilisateurs specifiques.
 * @param {string[]} userIds - Les utilisateurs a notifier.
 * @param {string} excludeUserId - L'utilisateur a exclure.
 * @return {Promise<string[]>} Liste des tokens.
 */
async function getTokensForUsers(userIds, excludeUserId) {
  const snap = await db.collection("fcmTokens").get();
  return snap.docs
    .map((d) => d.data())
    .filter((d) => userIds.includes(d.userId) && d.userId !== excludeUserId)
    .map((d) => d.token)
    .filter(Boolean);
}

/**
 * Envoie des notifications push.
 * @param {string[]} tokens - Les tokens FCM.
 * @param {string} title - Titre.
 * @param {string} body - Corps.
 * @param {Object} data - Donnees.
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
          tag: "shiftsync-notif",
        },
        fcmOptions: {link: "https://aiddenow.github.io/ShiftSync/"},
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
      console.log(`Envoye: ${result.successCount} ok, ${result.failureCount} echecs`);
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

/**
 * Supprime les vieux messages pour garder MAX_MESSAGES au maximum.
 * Supprime aussi les fichiers Storage associes.
 * @return {Promise<void>}
 */
async function cleanupOldMessages() {
  const snap = await db.collection("chat")
    .orderBy("timestamp", "asc")
    .get();

  if (snap.size <= MAX_MESSAGES) return;

  const toDelete = snap.docs.slice(0, snap.size - MAX_MESSAGES);
  console.log(`Nettoyage: suppression de ${toDelete.length} anciens messages`);

  const batch = db.batch();
  for (const doc of toDelete) {
    const data = doc.data();
    if (data.storagePath) {
      try {
        await bucket.file(data.storagePath).delete();
        console.log(`Fichier supprime: ${data.storagePath}`);
      } catch (e) {
        console.log(`Fichier deja supprime: ${data.storagePath}`);
      }
    }
    batch.delete(doc.ref);
  }
  await batch.commit();
}

// Notification nouveau message chat + cleanup automatique
exports.onNewChatMessage = onDocumentCreated(
  {document: "chat/{messageId}", region: "europe-west1"},
  async (event) => {
    const message = event.data.data();
    if (!message || !message.sender) return;
    if (!message.text && !message.mediaUrl) return;

    // Garder seulement les 50 derniers messages
    await cleanupOldMessages();

    const title = `\u{1F4AC} ${message.sender}`;
    let body;
    if (message.mediaType === "image") body = "\u{1F4F7} Photo";
    else if (message.mediaType === "video") body = "\u{1F3A5} Video";
    else if (message.text) {
      body = message.text.length > 100
        ? message.text.substring(0, 97) + "..."
        : message.text;
    } else return;

    const mentions = message.mentions || [];
    let tokens;
    if (mentions.length > 0) {
      console.log(`Mentions: ${mentions.join(", ")}`);
      tokens = await getTokensForUsers(mentions, message.sender);
    } else {
      tokens = await getTokensExcept(message.sender);
    }

    if (tokens.length === 0) return;

    await sendNotifications(tokens, title, body, {
      type: "chat",
      sender: message.sender,
    });
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
    let changedValue = null;
    let previousValue = null;
    for (const emp of Object.keys(after)) {
      if (after[emp] !== before[emp]) {
        changedEmployee = emp;
        changedValue = after[emp];
        previousValue = before[emp];
        break;
      }
    }
    if (!changedEmployee) return;
    // Ignorer les changements de congés — gérés par onVacationAnnouncement
    if (changedValue === "Congés 🌴" || previousValue === "Congés 🌴") return;

    const [year, month, day] = dateString.split("-").map(Number);
    const date = new Date(year, month - 1, day);
    const dateFormatted = date.toLocaleDateString("fr-FR", {
      weekday: "long",
      day: "numeric",
      month: "long",
    });

    const newShift = after[changedEmployee] || "Horaire supprime";
    const title = "\u{1F5D3}\uFE0F Planning modifie";
    const body = `${changedEmployee} \u2014 ${dateFormatted} : ${newShift}`;

    const tokens = await getTokensExcept(changedEmployee);
    await sendNotifications(tokens, title, body, {
      type: "schedule",
      date: dateString,
      sender: changedEmployee,
    });
  }
);
// Notification unique pour une période de congés
exports.onVacationAnnouncement = onDocumentCreated(
  {document: "vacationAnnouncements/{id}", region: "europe-west1"},
  async (event) => {
    const data = event.data.data();
    if (!data || !data.employee || !data.startDate || !data.endDate) return;

    const start = new Date(data.startDate + "T12:00:00");
    const end = new Date(data.endDate + "T12:00:00");

    const fmt = (d) => d.toLocaleDateString("fr-FR", { day: "numeric", month: "long" });

    const isSameDay = data.startDate === data.endDate;
    const title = "🌴 Congés enregistrés";
    const body = isSameDay
      ? `${data.employee} est en congés le ${fmt(start)}`
      : `${data.employee} est en congés du ${fmt(start)} au ${fmt(end)}`;

    const tokens = await getTokensExcept(data.employee);
    if (tokens.length === 0) return;

    await sendNotifications(tokens, title, body, {
      type: "vacation",
      sender: data.employee,
    });
  }
);