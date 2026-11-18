# Spooners website

Your community site: the three slanted panels from your sketch (Spooners Hub, Discord, Schedule), then
Watch, Community, the map and Support. Blue leads and white is the accent.

Everything on the page comes from `data/site.json`. Edit it in **Cutroom > Webpage**, not by hand.

## Files

| File | What it is |
|---|---|
| `index.html`, `style.css`, `app.js` | The site |
| `data/site.json` | All the content: links, schedule, games, raids, goal, vote, clips, map, support |
| `assets/` | Raid art (copied from `E:\Stream`) |
| `google-sheet-script.gs` | Sends "Pin yourself" sign-ups to your Google Sheet (setup steps at the top) |

## Editing (Cutroom > Webpage)

- Change anything on the left; the preview on the right updates as you type. **Desktop / Phone** switches the preview size.
- Your changes are saved as a draft automatically. The live site doesn't change until you press **Publish**.
- **Discard draft** goes back to what's published. Ctrl+Z / Ctrl+Y undo and redo (outside text boxes).
- The starter rows in Schedule and Game lineup are placeholders. Replace them, then press **I've replaced them**.

## Putting it online (free, once)

The steps are also in Cutroom > Webpage > *Put the site online*.

1. Install Git from git-scm.com.
2. Make a new public repository on github.com (for example `spooners`).
3. Paste its address in Cutroom and press **Connect**. Sign in to GitHub if Git asks.
4. On GitHub: **Settings › Pages** › Deploy from a branch › `main` / `(root)` › Save.

Your site is then at `https://<your-github-name>.github.io/spooners/`. Every Publish updates it within a minute.
A custom domain (like spooners.gg) can be added later under Settings › Pages.

## Discord bits

- **Join the Discord** buttons use the invite link from Cutroom (Links & Discord). Make it a link that never expires.
- **Live member count and faces**: Discord › Server Settings › **Widget** › turn on *Enable Server Widget*. If you
  pick an invite channel there too, the site uses that invite when you haven't set one.

## Map

- Your Google My Map is embedded. In My Maps, **Share** › *Anyone with the link can view*, or it shows blank.
- **Pin yourself**: viewers pick (or auto-fill) continent, country and state. Only those are saved, never an exact
  location. They land on a **Website pins** tab in your sheet, and the site shows a count per region.
  You still add the pins to My Maps yourself, the same as now. The script setup is at the top of `google-sheet-script.gs`.

## Notes

- The Twitch player only works on the live site (https) or in Cutroom's preview. For the YouTube live player, add your
  channel ID (starts with `UC`, from YouTube Studio › Settings › Channel › Advanced) in Cutroom.
- "Add to my calendar" downloads a file with every stream repeating weekly and a 15-minute reminder.
- The character creator and shop are previews. The real ones arrive with the Spooners game.
