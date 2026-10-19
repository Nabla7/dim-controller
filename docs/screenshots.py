# The README's screenshots (docs/*.jpg), taken of the page (vite, as in Develop) against a running sim: dim-go2-sim's
# examples/drive.py with people={"count": 2} for most, xarm-perception-sim for `arm`. Needs playwright and Chrome.
#   python docs/screenshots.py [name ...]    PNGs land in docs/shots/ (git-ignored); the jpgs are those at 82%
import asyncio, os, sys
from playwright.async_api import async_playwright
URL = os.environ.get("CONTROLLER_URL", "http://localhost:5173/apps/dim-controller/")
OUT = os.path.join(os.path.dirname(os.path.abspath(__file__)), "shots")
ARGS = ["--use-angle=metal", "--enable-gpu", "--ignore-gpu-blocklist"]
DESKTOP = dict(viewport={"width": 1440, "height": 900}, device_scale_factor=2)
PHONE = dict(viewport={"width": 390, "height": 844}, device_scale_factor=3, is_mobile=True, has_touch=True,
             user_agent="Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1")
PHONE_SIDE = {**PHONE, "viewport": {"width": 844, "height": 390}}

async def swap(page, title):
    await page.locator(f'[aria-label="{title}"]').first.hover()
    await page.locator(f'[aria-label="{title}: Make this the main view (swap)"]').first.click(timeout=5000)

async def desktop(page):
    await page.wait_for_timeout(15000)

async def scene(page):
    await page.wait_for_timeout(8000)
    await swap(page, "3D view")
    await page.wait_for_timeout(3000)
    await page.mouse.move(700, 450)
    for _ in range(6):
        await page.mouse.wheel(0, 250)
        await page.wait_for_timeout(150)
    await page.wait_for_timeout(20000)

async def layers(page):
    await scene(page)
    await page.locator('[aria-label="3D view"]').first.hover()
    await page.locator(".scene-clouds").first.click(force=True)
    await page.wait_for_timeout(2000)

async def network(page):
    await page.wait_for_timeout(5000)
    await page.get_by_test_id("bar-link").click()
    await page.wait_for_timeout(65000)

async def map_view(page):
    await page.wait_for_timeout(8000)
    await swap(page, "Map")
    await page.wait_for_timeout(2000)
    await page.mouse.move(700, 420)
    for _ in range(4):
        await page.mouse.wheel(0, -250)
        await page.wait_for_timeout(150)
    await page.wait_for_timeout(6000)

async def record(page):
    await page.wait_for_timeout(8000)
    await page.locator('[aria-label="Recording options"]').first.click()
    await page.wait_for_timeout(4000)

async def quality(page):
    await page.wait_for_timeout(8000)
    await page.locator('[aria-label="Camera"]').first.hover()
    await page.locator('[aria-label="Latency or quality"]').first.click()
    await page.wait_for_timeout(1500)

async def palette(page):
    await page.wait_for_timeout(8000)
    await page.keyboard.press("/")
    await page.keyboard.type("camera")
    await page.wait_for_timeout(1000)

async def keys(page):
    await page.wait_for_timeout(8000)
    await page.keyboard.press("?")
    await page.wait_for_timeout(1000)

async def top_down(page):
    await scene(page)
    await page.keyboard.press("/")
    await page.keyboard.type("3D view: top-down")
    await page.wait_for_timeout(500)
    await page.keyboard.press("Enter")
    await page.wait_for_timeout(5000)

async def phone_view(page, label):
    await page.wait_for_timeout(8000)
    await page.locator('button[aria-label="Switch view"]').first.tap()
    await page.wait_for_timeout(500)
    await page.locator('[role="menu"][aria-label="Switch view"] button', has_text=label).first.tap()
    await page.wait_for_timeout(10000)

async def phone_3d(page):
    await phone_view(page, "3D")

async def phone_map(page):
    await phone_view(page, "Map")

async def phone_drawer(page):
    await page.wait_for_timeout(10000)
    await page.locator('[aria-label="Right panels"]').first.tap()
    await page.wait_for_timeout(1500)

SET_RANGE = """([el, value]) => {
    Object.getOwnPropertyDescriptor(HTMLInputElement.prototype, "value").set.call(el, value)
    el.dispatchEvent(new Event("input", { bubbles: true }))
    el.dispatchEvent(new PointerEvent("pointerup", { bubbles: true }))
}"""

async def arm(page):
    await page.wait_for_timeout(10000)
    await swap(page, "3D view")
    await page.wait_for_timeout(5000)
    sliders = page.locator('[data-testid="manip-joints"] input[type="range"]')
    for index, value in [(0, "0.9"), (1, "0.35"), (2, "-0.6"), (4, "0.8")]:
        if await sliders.count() > index:
            await page.evaluate(SET_RANGE, [await sliders.nth(index).element_handle(), value])
            await page.wait_for_timeout(700)
    await page.wait_for_timeout(2000)
    await page.get_by_test_id("manip-preview").first.click()
    await page.wait_for_timeout(1000)

async def phone(page):
    await page.wait_for_timeout(15000)

SHOTS = {
    "desktop": (DESKTOP, "dark", desktop),
    "scene": (DESKTOP, "dark", scene),
    "layers": (DESKTOP, "dark", layers),
    "network": (DESKTOP, "dark", network),
    "map": (DESKTOP, "dark", map_view),
    "record": (DESKTOP, "dark", record),
    "quality": (DESKTOP, "dark", quality),
    "palette": (DESKTOP, "dark", palette),
    "keys": (DESKTOP, "dark", keys),
    "phone": (PHONE, "dark", phone),
    "arm": (DESKTOP, "dark", arm),
    "top_down": (DESKTOP, "dark", top_down),
    "phone_3d": (PHONE, "dark", phone_3d),
    "phone_map": (PHONE, "dark", phone_map),
    "phone_drawer": (PHONE, "dark", phone_drawer),
    "phone_side": (PHONE_SIDE, "dark", phone),
}

async def take(p, name):
    context_options, scheme, act = SHOTS[name]
    # one profile per shape, so the robot model's meshes come from the page's IndexedDB cache after the first shot
    profile = os.path.join(OUT, "profile_" + ("phone" if context_options.get("is_mobile") else "desktop"))
    browser = context = await p.chromium.launch_persistent_context(profile, channel="chrome", headless=True, args=ARGS, **context_options, color_scheme=scheme)
    try:
        page = context.pages[0] if context.pages else await context.new_page()
        await page.goto(URL)
        await page.evaluate("localStorage.clear()")  # the layout is the device's: start each shot from the default
        await page.reload()
        await act(page)
        reconnect = page.get_by_role("button", name="Reconnect")
        if await reconnect.count() and await reconnect.first.is_visible():  # a load spike disengaged driving
            await reconnect.first.click()
            await page.wait_for_timeout(4000)
        await page.screenshot(path=f"{OUT}/{name}.png", timeout=30000)
        print("ok", name)
    except Exception as error:
        print("FAIL", name, str(error)[:300])
    finally:
        await browser.close()

async def main():
    os.makedirs(OUT, exist_ok=True)
    async with async_playwright() as p:
        for name in sys.argv[1:] or SHOTS:
            await take(p, name)
            sys.stdout.flush()
asyncio.run(main())
