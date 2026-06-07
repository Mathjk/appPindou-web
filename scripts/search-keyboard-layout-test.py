import os

from playwright.sync_api import expect, sync_playwright

BASE_URL = os.environ.get("BASE_URL", "http://localhost:8082")


def first_exact_text_rect(page, text):
    return page.evaluate(
        """
        (text) => {
          const candidates = [...document.querySelectorAll('div, span')]
            .filter((element) => element.textContent === text)
            .map((element) => {
              const rect = element.getBoundingClientRect();
              return { top: rect.top, bottom: rect.bottom, height: rect.height };
            })
            .filter((rect) => rect.height > 0);
          return candidates[0] || null;
        }
        """,
        text,
    )


def tabbar_top(page):
    return page.evaluate(
        """
        () => {
          const labels = ['豆仓', '图纸', '采购', '设置'];
          const tabs = [...document.querySelectorAll('div')]
            .filter((element) => labels.includes(element.textContent || ''))
            .map((element) => element.getBoundingClientRect())
            .filter((rect) => rect.height >= 32 && rect.bottom > window.innerHeight - 90);
          return tabs.length ? Math.min(...tabs.map((rect) => rect.top)) : window.innerHeight;
        }
        """
    )


def main():
    with sync_playwright() as p:
        browser = p.chromium.launch(headless=True)
        page = browser.new_page(viewport={"width": 390, "height": 844}, is_mobile=True, has_touch=True)
        page.goto(BASE_URL)
        page.wait_for_load_state("networkidle")
        page.evaluate("localStorage.clear()")
        page.reload()
        page.wait_for_load_state("networkidle")

        search = page.get_by_label("色号搜索")
        search.click()
        expect(page.get_by_label("输入数字9")).to_have_count(0)
        page.set_viewport_size({"width": 390, "height": 520})
        page.wait_for_timeout(300)
        search.fill("A9")
        expect(search).to_have_value("A9")
        expect(page.get_by_label("输入数字9")).to_have_count(0)

        row_rect = first_exact_text_rect(page, "A9")
        assert row_rect, "Filtered A9 row should exist after search"
        bottom_limit = tabbar_top(page) - 4
        assert row_rect["top"] >= 0, f"A9 row should stay in viewport: {row_rect}"
        assert row_rect["bottom"] <= bottom_limit, f"A9 row should not be pushed under tabbar: row={row_rect}, tabbarTop={bottom_limit + 4}"

        browser.close()
        print("search keyboard layout tests passed")


if __name__ == "__main__":
    main()
