# Meghbitan Homestay booking system

This version uses the Firebase **Spark (no-cost) plan** for email/password authentication, Firestore, Firebase Hosting, and Firebase Cloud Messaging. It does not deploy Cloud Functions or require Google Cloud billing. Bookings fail closed: a booking is not reported as saved unless Firestore accepts it.

Background reminders use a GitHub Actions workflow every five minutes. To keep the scheduler free of GitHub Actions charges, the GitHub repository must be **public**. The application source/workflow are public; guest bookings, Firebase service-account credentials, and push tokens are not in the repository.

## Free deployment

1. Create a Firebase project and keep it on the Spark plan. **Do not upgrade to Blaze or enable billing.** Create Firestore in `asia-south1`.
2. Register a Web App in Firebase Project settings. Copy its web configuration into `firebase-config.js`. In Project settings → Cloud Messaging → Web Push certificates, generate a VAPID key and copy it into `MEGHBITAN_FIREBASE_VAPID_KEY`.
3. In Authentication → Sign-in method, enable **Email/Password**. Create one owner account from Authentication → Users. Sign into that same owner account on all owner devices so bookings and room locks share one private database namespace. Do not enable public sign-up.
4. Install Node.js 22 and the Firebase CLI. Build the local stylesheet and deploy Firestore rules/indexes and Firebase Hosting:

   ```powershell
   npm ci
   npm run build
   firebase login
   firebase use --add
   firebase deploy --only firestore:rules,firestore:indexes,hosting
   ```

   Firebase Hosting supplies HTTPS; do not open the HTML directly as a `file://` URL.

5. Create a **public** GitHub repository and push this source to its default branch. Add a GitHub Actions repository secret named `FIREBASE_SERVICE_ACCOUNT_JSON` containing the JSON for a dedicated Firebase service-account key. Grant that account the `Cloud Datastore User` and `Firebase Cloud Messaging API Admin` roles required for Firestore data access and push delivery. Do not commit the service-account JSON or put it in `firebase-config.js`.
6. In GitHub → Actions, confirm **Dispatch booking reminders** is enabled. Use **Run workflow** for an immediate manual run; the schedule otherwise checks approximately every five minutes. Enable device notifications on each browser and use **Test Alert** to enqueue a push test.
7. Periodically inspect Firebase usage and GitHub Actions logs. Do not link a billing account to create a budget alert; keep the project on Spark so usage cannot silently switch to paid service.

The web API key and VAPID public key in `firebase-config.js` are client-side settings, not private credentials. Restrict the API key to the deployed domain. Never publish guest data, service-account credentials, or private keys.

## Free-tier limits and reliability trade-offs

- Firebase Spark has strict quotas and no production SLA. Current Firebase pricing documentation lists Firestore free quotas (including 1 GiB stored data, 50,000 document reads/day, and 20,000 writes/day) and Firebase Hosting free storage/transfer limits. Quotas and eligible features may change; check [Firebase pricing](https://firebase.google.com/pricing) before launch. If a quota is reached, Firestore may reject reads/writes until quota reset; this app reports failures rather than pretending data was saved.
- There are no paid managed backups on this setup. Export bookings regularly using a documented, encrypted backup process and test restoring them. Keep guest exports private. If there is no separate backup location, data recovery is not guaranteed.
- GitHub scheduled workflows are best-effort, not an exact-time or high-availability scheduler. GitHub can delay schedule starts during high load and disables scheduled workflows in inactive public repositories. A reminder may arrive several minutes late or not at all during outages or quota/authentication problems. Check the workflow run history and Firebase data usage. This is the trade-off for a no-cost background scheduler.
- The workflow processes up to 100 due reminders and 100 push tests per run. Extra due items are handled on a following run. Keep scheduled workload and Firebase free-tier reads/writes below quotas.
- Android Chrome and desktop Chrome/Edge can receive push after permission is granted. iPhone/iPad require iOS/iPadOS 16.4 or later, adding the HTTPS site to the Home Screen, then granting notification permission from the installed web app. Enable alerts separately on every browser/device.
- Browser/OS settings, battery restrictions, denied permissions, network outages, and push-provider delays can prevent or delay delivery. No free web-push service can guarantee every notification. A partial provider failure can also cause a retry and duplicate delivery to devices that already received that reminder. The foreground app also checks reminders while open.

## Data and application behavior

- Firestore rules allow each authenticated account to read/write only its own `artifacts/meghbitan-homestay-app/users/{uid}` documents. Unauthenticated and unmatched requests are denied.
- Room/date locks are read and written in the same Firestore transaction as the booking. Simultaneous attempts to reserve the same room/date are rejected rather than silently double-booked.
- The dashboard listens only to bookings overlapping its selected seven-day window. The booking directory loads 50 records per page; search applies to the current page.
- Reminder schedules are stored in Firestore and sent by the GitHub Actions dispatcher using its server-side service account. Device registration tokens remain in the owner's Firestore path.
- Transactions have Firestore operation limits. A booking with more than 450 room-night locks/associated changes is rejected explicitly; shorten the stay or reduce rooms/reminders rather than saving partially.
- If you have already stored bookings from the earlier Firebase version, pause use and rebuild room/date lock documents before using this version; otherwise those legacy bookings will not block new reservations. With a new Firebase project, there is no legacy migration.

This workspace contains deployment scaffolding, not a provisioned Firebase project or public GitHub repository. Finish the steps above, stay on Spark, verify the free quotas fit your actual booking volume, test simultaneous bookings and restore procedures, and test push on each actual target device before entering live guest data.
