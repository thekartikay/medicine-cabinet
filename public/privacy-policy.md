# MediCab Privacy Policy

**Effective date: 2026-05-06**

> **PLACEHOLDER — pending review by counsel.** This document is a working draft. The final published version will be reviewed and signed off by the company's legal advisor before release. If you are reading this in a deployed build, please ask the team to swap in the approved copy.

## 1. Who we are

MediCab is operated by the MediCab team. We build a household medication management product for families in India. You can reach us at support@medicab.app for any privacy question, correction, or deletion request.

## 2. What information we collect

When you use MediCab we collect:

- **Account details** — your name, email, phone number, and Google sign-in identifier (whichever you used to sign in).
- **Household membership** — the household you create or join, and the role assigned to you (admin, member, or caregiver).
- **Medicines and treatments** — the medicines you add to your cabinet, dose schedules you configure, and dose history (taken / late / skipped / missed).
- **Device information** — the platform you signed in from (web, iOS, Android), and an FCM push notification token if you enable reminders.
- **Consent record** — a signed timestamp recording that you accepted this Privacy Policy, the version you accepted, your app version, and your platform.

We do **not** collect or store payment card data ourselves. Subscription billing is processed by Razorpay and RevenueCat under their own privacy policies.

## 3. Why this is health information

Medicine names, dose schedules, and dose history reveal information about your physical health. Under India's Digital Personal Data Protection Act, 2023 (the **DPDP Act**), this is treated as sensitive personal information and is subject to additional safeguards. By using MediCab you give explicit, informed consent for us to process this information for the purposes set out in section 4.

## 4. How we use your information

We process your information to:

- Run the MediCab app and remind you and your household of doses on time.
- Synchronise dose records across the devices in your household, so that an admin or caregiver can see whether a member has taken a scheduled dose.
- Detect drug interactions when you ask, by sending the relevant medicine names to a Google Gemini model on your behalf. Gemini queries are routed through our server; the API key never leaves our infrastructure.
- Send transactional notifications (push, and if you opt in, WhatsApp) about doses, restock requests, and household events.
- Diagnose issues, prevent abuse, and meet our legal obligations.

We do not sell your information, and we do not show you third-party advertising.

## 5. Where your data is stored

Your data is stored on Google Cloud Firestore in the **Mumbai (asia-south1)** region. Backups are kept within India.

## 6. Who can see your data

- **You** can see your own medicine cabinet, treatments, and dose history.
- **Other members of your household** can see medicines and dose status for the household, in line with their assigned role.
- **Caregivers** you invite can see today's dose status only — they cannot see your medicine cabinet or historical adherence.
- **MediCab employees** can access your data only when investigating a support request, fixing a bug, or responding to a lawful request.

## 7. How long we keep it

We keep your data for as long as your account is active. When you delete your account from Settings → Account & Privacy, we soft-delete it for 30 days so you can recover it by signing back in. After 30 days we permanently delete your medicines, dose history, and AI query logs.

We retain a minimal, anonymised consent record (without your name or email) for compliance with the DPDP Act even after account deletion.

## 8. Your rights

You have the right to:

- **Access** your information at any time inside the app.
- **Correct** information that is inaccurate.
- **Withdraw consent** by deleting your account.
- **Complain** to the Data Protection Board of India if you believe we have mishandled your information.

## 9. Children

MediCab is intended for adults managing medicines for themselves or for family members. If you create an account on behalf of a minor or an elderly relative, you confirm that you are their lawful caregiver and that you have authority to provide consent on their behalf.

## 10. Changes to this policy

If we change this policy materially, we will ask you to consent again the next time you open MediCab. The version date at the top of this page tells you which version is currently in force.

---

*Questions? Email support@medicab.app.*
