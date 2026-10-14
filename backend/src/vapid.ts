import webpush from "web-push";

// Prints a fresh VAPID key pair for web push. Put the two lines in .env.
const keys = webpush.generateVAPIDKeys();
console.log(`VAPID_PUBLIC_KEY=${keys.publicKey}\nVAPID_PRIVATE_KEY=${keys.privateKey}`);
