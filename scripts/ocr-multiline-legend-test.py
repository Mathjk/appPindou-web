import os
import json
from pathlib import Path

from playwright.sync_api import expect, sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:8082")
REPO_ROOT = Path(__file__).resolve().parents[1]
STORAGE_KEY = "appPindou:data:v1"


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


IMAGE_PATH = resolve_test_image("OCR_MULTILINE_TEST_IMAGE", "pdpng4.png")

OCR_SPACE_TEXT = """E14\tE15\tF1\tF14\tF6\tF7\tF8\tG2\tH12\tH3\tH4\tH5\tH6\t
X132\tx110\tx5\tx15\tx55\tX197\tx363\tx57\tx133\tx20\tx241\tx533\tx151\t
#E B408302\tTE BH0E302\t
H7\tM12\tM9\t
ME BH0:302\t#3 540:302\t
x462\tx13\tx13\t#E 8403302\t#E B40E30\t"""

EXPECTED = {
    "E14": 132,
    "E15": 110,
    "F1": 5,
    "F14": 15,
    "F6": 55,
    "F7": 197,
    "F8": 363,
    "G2": 57,
    "H12": 133,
    "H3": 20,
    "H4": 241,
    "H5": 533,
    "H6": 151,
    "H7": 462,
    "M12": 13,
    "M9": 13,
}


def main():
    image = Path(IMAGE_PATH)

    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 412, "height": 915}, is_mobile=True, has_touch=True)
        page.route(
            "https://api.ocr.space/parse/image",
            lambda route: route.fulfill(
                status=200,
                content_type="application/json",
                body=json.dumps({"ParsedResults": [{"ParsedText": OCR_SPACE_TEXT}], "IsErroredOnProcessing": False}),
            ),
        )

        page.goto(BASE_URL)
        page.wait_for_load_state("networkidle")
        page.evaluate("localStorage.clear()")
        page.reload()
        page.wait_for_load_state("networkidle")

        page.get_by_text("图纸", exact=True).click()
        page.get_by_placeholder("例如：小熊挂件").fill("双行图例 OCR 测试")
        page.get_by_text("新建", exact=True).click()
        with page.expect_file_chooser() as file_chooser_info:
            page.get_by_text("上传并裁剪图纸", exact=True).click()
        file_chooser_info.value.set_files(str(image))

        expect(page.get_by_text("裁剪图纸", exact=True)).to_be_visible(timeout=15000)
        page.get_by_text("确认裁剪并识别", exact=True).click()
        expect(page.get_by_text("OCR 已识别 16 个颜色", exact=False).first).to_be_visible(timeout=15000)
        page.wait_for_timeout(1000)

        data = page.evaluate(f"JSON.parse(localStorage.getItem('{STORAGE_KEY}'))")
        items = {item["code"]: item["quantity"] for item in data["projects"][0]["items"]}
        assert items == EXPECTED, f"Unexpected multi-line OCR items: {items}"

        browser.close()
        print("ocr multi-line legend tests passed")


if __name__ == "__main__":
    main()
