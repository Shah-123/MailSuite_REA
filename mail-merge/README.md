# CSC outreach mail merge

A Google Sheets script that sends the personalised emails on your professor sheet from
your own Gmail. It runs on Google's servers, so your computer can be off.

- Up to **40 emails per weekday**, between **9:00 and 12:00 China time** (06:00–09:00 in
  Pakistan), spread over that window with pauses between emails.
- Strong fit first, then Good, then Moderate.
- **One professor per research group.** The next person in a group is emailed only
  after you set the first one's Status to Declined or No reply.
- Attaches your CV, sets Status to "Emailed" and fills in Date emailed (so Follow-up due
  works). Every send is listed on a "Send log" sheet.
- Spots replies and bounces in your inbox and sets Status to "Replied" or "Bounced".
  Auto-replies such as "out of office" are ignored.

With your list: 475 professors have an address. 320 can be emailed right away, which
takes 8 weekdays. The other 155 wait for a group-mate first.

## Set up (about 10 minutes, on a computer)

1. **Put the sheet in Google Sheets.** Upload `CSC_Professors_Shahkar_Ahmad_1.xlsx` to
   Google Drive, open it, then choose **File → Save as Google Sheets**. Use that new
   copy from now on.
2. **Put your CV in Drive.** Upload the PDF, then right-click it → **Share → Copy link**.
3. **Add the script.** In the Google Sheet: **Extensions → Apps Script**. Delete what's
   there, paste all of [`Code.gs`](Code.gs), and paste your CV link between the quotes
   of `CV_DRIVE_LINK`. Click **Save** (the disk icon).
4. **Reload the sheet.** A **Mail merge** menu appears. Choose **1. Set up**.
   - Google asks for permission to send email, read the sheet and open your CV.
   - It shows "Google hasn't verified this app" because the script is your own. Click
     **Advanced → Go to … (unsafe)**, then **Allow**.
5. **Mail merge → 2. Send a test to myself.** You receive the first professor's email
   with "[TEST]" in the subject. Check the text, the CV attachment and how it looks on
   your phone. Nothing is marked as sent.
6. **Mail merge → 3. Preview next batch.** A "Next batch" sheet lists the 40 emails that
   go out next.
7. **Mail merge → Start daily sending.**

## Every day

- **Review tomorrow's 40 the evening before.** Use **Preview next batch**, then open each
  cited paper and check that the sentence about it is right. Each draft was written from
  the paper's abstract, and a wrong claim about a professor's own work hurts your chances
  with them.
- **To fix an email,** edit its body on "Email drafts". The script sends whatever is
  there at send time.
- **To skip a professor,** set their Status to **On hold**.
- **When someone replies,** their Status changes to "Replied". Read the reply and update
  Status yourself (Interview, Acceptance letter, Declined…).
- **Follow-ups are manual.** When Follow-up due turns red, reply in the same Gmail thread
  and set Status to "Follow-up sent". If there's still no answer a week later, set "No
  reply" so the next person in that group gets emailed.
- **To pause,** choose **Mail merge → Stop sending**. Start again whenever you like.

## Changing the settings

These are at the top of `Code.gs`. Save after changing them.

| Setting | Default | Meaning |
| --- | --- | --- |
| `DAILY_LIMIT` | `40` | Emails per weekday |
| `WINDOW_START_HOUR`, `WINDOW_END_HOUR` | `9`, `12` | Sending window, in `TIMEZONE` |
| `SEND_WEEKDAYS` | Mon–Fri | 1 = Monday … 7 = Sunday |
| `TIMEZONE` | `Asia/Shanghai` | The professors' timezone |
| `ATTACH_CV` | `true` | Attach the PDF from `CV_DRIVE_LINK` |
| `SENDER_NAME` | `Shahkar Ahmad Shah` | Name shown in the From line |

## Limits

- **Daily limit.** A personal Gmail account can send about 100 emails a day from a
  script. 40 a day plus tests stays well under that.
- **Reply detection** looks at inbox threads from the last 3 days, every 30 minutes. A
  reply that a filter moves out of the inbox won't be detected; mark it yourself.
- **Re-sends.** The script never emails an address that's already on the Send log, even
  if you set a Status back to "Not contacted".
