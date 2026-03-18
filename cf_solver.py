#!/usr/bin/env python3
"""
Cloudflare bypass using botasaurus-driver.
Outputs cookies + user-agent as JSON to stdout.
Called from Node.js via child_process.
"""
import json
import sys
import os

def solve(url):
    from botasaurus_driver import Driver

    chrome_path = os.environ.get("CHROME_PATH")
    driver = Driver(
        headless=False,
        wait_for_complete_page_load=True,
        chrome_executable_path=chrome_path,
        arguments=[
            "--disable-gpu",
            "--disable-dev-shm-usage",
        ],
    )
    try:
        driver.google_get(url, bypass_cloudflare=True)
        cookies = driver.get_cookies_dict()
        ua = driver.user_agent
        title = driver.title
        current_url = driver.current_url

        result = {
            "success": True,
            "cookies": cookies,
            "cookieString": "; ".join(f"{k}={v}" for k, v in cookies.items()),
            "userAgent": ua,
            "url": current_url,
            "title": title,
        }
    except Exception as e:
        result = {
            "success": False,
            "error": str(e),
            "cookies": {},
            "cookieString": "",
            "userAgent": "",
        }
    finally:
        try:
            driver.close()
        except Exception:
            pass

    # Output JSON to stdout (Node.js reads this)
    print(json.dumps(result))


if __name__ == "__main__":
    target_url = sys.argv[1] if len(sys.argv) > 1 else os.environ.get(
        "TARGET_URL", "https://id.mgkomik.cc"
    )
    solve(target_url)
