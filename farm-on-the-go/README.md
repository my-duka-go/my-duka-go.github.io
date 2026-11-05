# Farm on the Go

Offline-first app for Kenyan horticulture, served at https://app.mydukago.co.ke/farm-on-the-go/.

- **Farmer side:** plantings with crop calendars (16 common crops), spray / feeding / scouting reminders, activity records with pre-harvest-interval warnings, harvests, sales (cash, M-Pesa, credit), expenses, profit and loss per planting, seedling orders placed with nurseries, plant doctor (photo + symptom guide).
- **Propagator side:** seedling batches with ready dates, live stock (raised / booked / sold / available), orders to accept or decline with WhatsApp replies, stock list to share, nursery profit and loss.

Everything is stored on the phone (IndexedDB `farm_on_the_go_v1`, cache prefix `farm-on-the-go-shell-`), separate from the POS and Clinic apps on the same address.

`supabase/functions/plant-doctor` is the AI photo check for the online version (Claude vision; key kept as the `ANTHROPIC_API_KEY` server secret). It is not deployed yet - before it is, it needs a sign-in check so only Farm on the Go users can call it.

Spray advice names active ingredients only. Farmers must use PCPB-registered products at the label rate and keep the pre-harvest interval.
