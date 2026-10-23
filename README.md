# adcoin-mm-backend (Render)

Telegram bot + API (Node.js, Express, Telegraf, MongoDB)

## လုပ်ဆောင်ချက်
- `/start` → channel join မလုပ်ရသေးလျှင် channel link ပို့မည် → join ပြီး `/start` ထပ်နှိပ်လျှင် Mini App ဖွင့်ခလုတ်ပို့မည်
- Telegram initData ကို HMAC နဲ့ စစ်ပြီး user ကို ခွဲခြားသည် (ဟန်ဆောင်၍ မရ)
- ကြော်ငြာကြည့်လျှင် coin 15/20 (ကျပန်း) — **Adsgram Reward URL callback ရောက်မှသာ** coin ပေးသည်
- နေ့စဉ် check-in, Lucky Box, channel task (ကြော်ငြာမကြည့်ဘဲ သုံးနိုင်သော feature များ)
- ငွေထုတ်တောင်းဆိုမှု → admin ကို bot မှ အကြောင်းကြား → `/paid` နှင့် `/reject`
- ငွေထုတ်ပြီး သက်သေ → public API + proof channel သို့ အလိုအလျောက် တင်ပေးသည်

## Render တွင် Deploy လုပ်နည်း
1. GitHub တွင် repo အသစ် (ဥပမာ `adcoin-mm-backend`) ဖွင့်ပြီး ဤ folder ထဲက file အားလုံး push လုပ်ပါ။
2. https://cloud.mongodb.com တွင် **Atlas cluster** (Free M0) ဖန်တီးပါ။
   - Database Access → user + password ဖန်တီးပါ။
   - Network Access → `0.0.0.0/0` ထည့်ပါ (Render IP ပြောင်းနိုင်သဖြင့်)။
   - Connect → Drivers မှ connection string ကို copy ကူးပါ (`MONGODB_URI`)။
3. Render → **New → Web Service** → ဤ repo ကို ရွေးပါ။
   - Runtime: Node
   - Build Command: `npm install`
   - Start Command: `npm start`
4. **Environment** တွင် `.env.example` ထဲက variable များကို ဖြည့်ပါ (`MONGODB_URI` = အဆင့် ၂ က connection string)။
   - `PUBLIC_URL` = Render က ပေးသော service URL (ဥပမာ `https://adcoin-mm-backend.onrender.com`)
   - `WEBAPP_URL`, `FRONTEND_URL` = Vercel URL (frontend deploy ပြီးမှ ပြန်ဖြည့်၍ redeploy)
5. Bot ကို `CHANNEL_ID` channel နှင့် `PROOF_CHANNEL_ID` channel နှစ်ခုလုံးတွင် **admin** ခန့်ပါ။
6. Deploy ပြီးလျှင် Logs တွင် `DB ready` နှင့် `Webhook set` ပေါ်ရမည်။

> Render Free web service သည် မသုံးဘဲနေလျှင် အိပ်သွားပြီး ပထမဆုံး request တွင် ၃၀–၆၀ စက္ကန့်ကြာနိုင်သည်။
> အသုံးပြုသူများလာလျှင် paid plan သို့ ပြောင်းရန် (သို့) UptimeRobot ဖြင့် `/api/health` ကို ၅ မိနစ်တစ်ခါ ping လုပ်ပါ။
> Atlas Free (M0) သည် 512MB ကန့်သတ်ချက်ရှိသည်။ user များလာလျှင် paid tier သို့ ပြောင်းပြီး backup ဖွင့်ထားပါ။ Transaction များသုံးသဖြင့် replica set (Atlas) ဖြစ်ရမည်။

## Adsgram တွင် သတ်မှတ်ရန်
1. https://partner.adsgram.ai တွင် Platform (Mini App URL = Vercel URL) နှင့် **Rewarded** block ဖန်တီးပါ။
2. Block ၏ **Reward URL** ကို ဤသို့ ထည့်ပါ (`[userId]` နေရာတွင် Adsgram က user id ထည့်ပေးသည်):

```
https://<render-url>/api/adsgram/reward?userid=[userId]&secret=<ADSGRAM_REWARD_SECRET>
```

3. Block ID ကို frontend ၏ `VITE_ADSGRAM_BLOCK_ID` တွင် ထည့်ပါ။
   Reward URL ၏ placeholder ပုံစံကို Adsgram dashboard / docs တွင် တစ်ကြိမ် ထပ်စစ်ပါ (docs ၏ reward-url စာမျက်နှာကို ကျွန်ုပ် ဖတ်၍ မရခဲ့ပါ)။
   Reward URL မသတ်မှတ်ရသေးမီ စမ်းသပ်လိုလျှင် `REWARD_MODE=client` ကို ယာယီသုံးနိုင်သော်လည်း လုံခြုံမှုနည်းသဖြင့် production တွင် `callback` ကိုသာ သုံးပါ။

## Admin commands (ADMIN_IDS ထဲက account မှသာ)
| Command | လုပ်ဆောင်ချက် |
|---|---|
| `/pending` | စောင့်ဆိုင်းနေသော ငွေထုတ်တောင်းဆိုမှုများ |
| `/paid <id> <ငွေလွှဲအမှတ်>` | ငွေလွှဲပြီးကြောင်း မှတ်၊ user ကို အကြောင်းကြား၊ proof channel သို့ တင် |
| `/reject <id> <အကြောင်းရင်း>` | ငြင်းပယ်ပြီး coin ပြန်အမ်း |
| `/stats` | စုစုပေါင်း စာရင်းအကျဉ်း |
| `/ban <id>` / `/unban <id>` | user ပိတ်/ဖွင့် |

## ဝင်ငွေနှင့် coin တန်ဖိုး (အရေးကြီး)
ငွေထုတ်ပေးရမည့် ငွေကို Adsgram မှ ရသော ဝင်ငွေထဲကမှ ပေးရမည်ဖြစ်သည်။ ကြော်ငြာတစ်ခုလျှင် ဝင်ငွေ မည်မျှရသည်ကို
partner.adsgram.ai statistics တွင် ကြည့်ပြီး `KYAT_PER_1000_COINS` ကို ဝင်ငွေထက် နည်းအောင် ချိန်ပါ။
(ပုံမှန် default: coin 1,000 = 100 ကျပ် ⇒ ကြော်ငြာတစ်ခု ≈ 1.5–2 ကျပ်)
