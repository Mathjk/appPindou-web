import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:8082")
REPO_ROOT = Path(__file__).resolve().parents[1]
TMP_DIR = REPO_ROOT / ".tmp-crop"


def resolve_test_image(env_name, file_name):
    explicit = os.environ.get(env_name)
    candidates = []
    if explicit:
        candidates.append(Path(explicit).expanduser())
    candidates.extend(
        [
            REPO_ROOT / "test-fixtures" / file_name,
            REPO_ROOT / "temp" / file_name,
            REPO_ROOT.parent / "appPindou" / "temp" / file_name,
        ]
    )
    for candidate in candidates:
        if candidate.exists():
            return candidate
    raise FileNotFoundError(f"Missing test image {file_name}. Set {env_name} or place it in test-fixtures/.")


IMAGE_PATH = resolve_test_image("CROP_TEST_IMAGE", "pdpng1.png")


def get_crop_rect(page):
    return page.evaluate(
        """
        () => {
          const movePad = document.querySelector('[aria-label="拖动裁剪框"]');
          if (!movePad || !movePad.parentElement) throw new Error('Crop move pad not found');
          const rect = movePad.parentElement.getBoundingClientRect();
          return { left: rect.left, top: rect.top, width: rect.width, height: rect.height };
        }
        """
    )


def drag_pointer(page, selector, dx, dy):
    page.evaluate(
        """
        ({ selector, dx, dy }) => {
          const element = document.querySelector(selector);
          if (!element) throw new Error(`Element not found: ${selector}`);
          const rect = element.getBoundingClientRect();
          const startX = rect.left + rect.width / 2;
          const startY = rect.top + rect.height / 2;
          const pointerId = Math.floor(Math.random() * 100000) + 1;
          const eventInit = {
            pointerId,
            pointerType: 'touch',
            isPrimary: true,
            bubbles: true,
            cancelable: true,
            button: 0,
            buttons: 1,
          };
          element.dispatchEvent(new PointerEvent('pointerdown', { ...eventInit, clientX: startX, clientY: startY }));
          window.dispatchEvent(new PointerEvent('pointermove', { ...eventInit, clientX: startX + dx, clientY: startY + dy }));
          window.dispatchEvent(new PointerEvent('pointerup', { ...eventInit, buttons: 0, clientX: startX + dx, clientY: startY + dy }));
        }
        """,
        {"selector": selector, "dx": dx, "dy": dy},
    )


def main():
    image = Path(IMAGE_PATH)
    if not image.exists():
        raise FileNotFoundError(f"Missing crop test image: {image}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 412, "height": 915}, is_mobile=True, has_touch=True)
        page.goto(BASE_URL)
        page.wait_for_load_state("networkidle")
        page.evaluate("localStorage.clear()")
        page.reload()
        page.wait_for_load_state("networkidle")

        page.get_by_text("图纸", exact=True).click()
        page.get_by_placeholder("例如：小熊挂件").fill("裁剪交互测试")
        page.get_by_text("新建", exact=True).click()
        expect(page.get_by_text("上传并裁剪图纸", exact=True)).to_be_visible()

        with page.expect_file_chooser() as file_chooser_info:
            page.get_by_text("上传并裁剪图纸", exact=True).click()
        file_chooser_info.value.set_files(str(image))

        expect(page.get_by_text("裁剪图纸", exact=True)).to_be_visible(timeout=15000)
        expect(page.locator('[aria-label="拖动裁剪框"]')).to_be_visible()
        expect(page.locator('[aria-label="缩放右下角"]')).to_be_visible()

        before_resize = get_crop_rect(page)
        drag_pointer(page, '[aria-label="缩放右下角"]', -72, -56)
        page.wait_for_timeout(100)
        after_resize = get_crop_rect(page)
        assert after_resize["width"] < before_resize["width"] - 40, f"Crop width did not shrink: {before_resize} -> {after_resize}"
        assert after_resize["height"] < before_resize["height"] - 30, f"Crop height did not shrink: {before_resize} -> {after_resize}"

        before_move = get_crop_rect(page)
        drag_pointer(page, '[aria-label="拖动裁剪框"]', 34, 22)
        page.wait_for_timeout(100)
        after_move = get_crop_rect(page)
        assert after_move["left"] > before_move["left"] + 20, f"Crop did not move right: {before_move} -> {after_move}"
        assert after_move["top"] > before_move["top"] + 12, f"Crop did not move down: {before_move} -> {after_move}"

        TMP_DIR.mkdir(exist_ok=True)
        page.screenshot(path=str(TMP_DIR / "crop-interaction-check.png"), full_page=True)
        browser.close()
        print("crop interaction tests passed")


if __name__ == "__main__":
    main()
