import os
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:8082")
IMAGE_PATH = os.environ.get("OCR_STORAGE_TEST_IMAGE", "/home/jk/appPindou/temp/pdpng1.png")
STORAGE_KEY = "appPindou:data:v1"


def main():
    image = Path(IMAGE_PATH)
    if not image.exists():
        raise FileNotFoundError(f"Missing OCR storage test image: {image}")

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 412, "height": 915}, is_mobile=True, has_touch=True)
        page.route(
            "https://api.ocr.space/parse/image",
            lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body='{"ParsedResults":[{"ParsedText":"G2 12"}],"IsErroredOnProcessing":false}',
            ),
        )

        page.goto(BASE_URL)
        page.wait_for_load_state("networkidle")
        page.evaluate("localStorage.clear()")
        page.reload()
        page.wait_for_load_state("networkidle")

        page.get_by_text("图纸", exact=True).click()
        page.get_by_placeholder("例如：小熊挂件").fill("OCR 保存体积测试")
        page.get_by_text("新建", exact=True).click()
        with page.expect_file_chooser() as file_chooser_info:
            page.get_by_text("上传并裁剪图纸", exact=True).click()
        file_chooser_info.value.set_files(str(image))

        expect(page.get_by_text("裁剪图纸", exact=True)).to_be_visible(timeout=15000)
        page.get_by_text("确认裁剪并识别", exact=True).click()
        expect(page.get_by_text("OCR 已识别", exact=False).first).to_be_visible(timeout=15000)
        page.wait_for_timeout(1500)

        assert page.locator("text=本地保存失败").count() == 0, "OCR flow should not show local save failure"
        raw = page.evaluate(f"localStorage.getItem('{STORAGE_KEY}') || ''")
        assert raw, "OCR flow should persist app data"
        assert len(raw) < 200_000, f"Persisted OCR data should not include large image data URLs: {len(raw)} chars"

        data = page.evaluate(f"JSON.parse(localStorage.getItem('{STORAGE_KEY}'))")
        project = data["projects"][0]
        assert project["items"][0]["code"] == "G2", "OCR item code should be persisted"
        assert project["items"][0]["quantity"] == 12, "OCR item quantity should be persisted"
        assert not project.get("imageUri"), "Persisted project should strip imageUri"
        assert not project.get("originalImageUri"), "Persisted project should strip originalImageUri"
        assert not project.get("croppedImageUri"), "Persisted project should strip croppedImageUri"

        browser.close()
        print(f"ocr storage quota tests passed ({len(raw)} chars)")


if __name__ == "__main__":
    main()
