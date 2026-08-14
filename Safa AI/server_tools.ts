import { Type } from "@google/genai";

export const SHARED_TOOL_DECLARATIONS = [
  {
    name: "memory",
    description:
      "Save durable information to persistent memory that survives across sessions. Memory is injected into future turns, so keep it compact and focused on facts that will still matter later.\n\n" +
      "WHEN TO SAVE (do this proactively, don't wait to be asked):\n" +
      "- User corrects you or says 'remember this' / 'don't do that again'\n" +
      "- User shares a preference, habit, or personal detail (name, role, timezone, coding style)\n" +
      "- You discover something about the environment (OS, installed tools, project structure)\n" +
      "- You learn a convention, API quirk, or workflow specific to this user's setup\n" +
      "- You identify a stable fact that will be useful again in future sessions\n\n" +
      "Do NOT save task progress, session outcomes, completed-work logs, or temporary TODO state to memory; use session_search to recall those from past transcripts.\n",
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: {
          type: Type.STRING,
          description: "The memory operation.",
          enum: ["add", "replace", "remove", "read"],
        },
        target: {
          type: Type.STRING,
          description: "Which memory scope to operate on.",
          enum: ["memory", "user"],
        },
        content: {
          type: Type.STRING,
          description: "The fact text for add/replace.",
        },
        old_text: {
          type: Type.STRING,
          description: "Matching substring when replacing or removing a fact.",
        },
      },
      required: ["action", "target"],
    },
  },
  {
    name: "session_search",
    description:
      "Search past chat conversation history across sessions using FTS5 search. Returns snippets and surrounding context.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "Keywords or phrase to search in prior chat history.",
        },
        limit: {
          type: Type.INTEGER,
          description: "Max results to return (default 3).",
        },
        session_id: {
          type: Type.STRING,
          description: "Optional specific session id to scroll.",
        },
        window: {
          type: Type.INTEGER,
          description: "Number of messages to return around the matched message in scroll mode.",
        },
      },
      required: [],
    },
  },
  {
    name: "delegateToSabit",
    description: "Delegates a browser-based or background automation task (like playing background music, loading a video, searching the web, or scraping a page) to Sabit, our independent second assistant worker.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        task: {
          type: Type.STRING,
          description: "The natural language instruction of the task to delegate, e.g. 'Play Believer on YouTube', 'Search Google for news'.",
        },
      },
      required: ["task"],
    },
  },
  {
    name: "browserOpen",
    description: "Opens a designated website URL or interface tab inside Myraa's web agent console.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: {
          type: Type.STRING,
          description: "The destination website address or path, e.g. youtube.com, google.com, instagram.com, wikipedia.org.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "browserSearch",
    description: "Enters a query search term inside the active website's search box (Google Search or YouTube Search).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "The text query term to search for.",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "browserClick",
    description: "Traces computer cursor and clicks on a target button, link, or video cell ID inside the active webpage viewport.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        selector: {
          type: Type.STRING,
          description: "The selector target ID, e.g. 'video-mWRsgZjdfQI' for a video, 'search-result-0' for Google link index, or 'play-button', 'pause-button'.",
        },
        description: {
          type: Type.STRING,
          description: "A short, friendly label description of the item being clicked.",
        },
      },
      required: ["selector"],
    },
  },
  {
    name: "browserMediaControl",
    description: "Controls ongoing video/audio stream media properties on YouTube, like play, pause, volume, mute, skip, and fullscreen.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: {
          type: Type.STRING,
          description: "The media controller command operation.",
          enum: ["play", "pause", "volume", "fullscreen", "exit_fullscreen", "mute", "unmute", "skip"],
        },
        value: {
          type: Type.INTEGER,
          description: "The value parameter; only relevant for set volume level, e.g. 50 for fifty percent.",
        },
      },
      required: ["action"],
    },
  },
  {
    name: "browserScroll",
    description: "Scrolls the currently active webpage vertically up or down.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        direction: {
          type: Type.STRING,
          description: "The scroll vector movement.",
          enum: ["up", "down"],
        },
        amount: {
          type: Type.INTEGER,
          description: "The distance height parameter in pixels (defaults to 300).",
        },
      },
    },
  },
  {
    name: "browserExtract",
    description: "Extracts text, links, prices, or media URLs from a currently rendered webpage.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        type: {
          type: Type.STRING,
          description: "The specific extraction target type.",
          enum: ["text", "links", "media", "prices"],
        },
        selector: {
          type: Type.STRING,
          description: "The target DOM ID selector node to extract information from.",
        },
      },
      required: ["type"],
    },
  },
{
    name: "desktopBrowserOpen",
    description: "Opens a full browser instance using Playwright PC Desktop Agent and navigates to a URL.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: {
          type: Type.STRING,
          description: "The URL to open in the real desktop browser.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "desktopBrowserNavigate",
    description: "Navigates the desktop browser to a URL. Alias of desktopBrowserOpen.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: {
          type: Type.STRING,
          description: "The destination URL to navigate to.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "desktopBrowserSearch",
    description: "Searches the web in the desktop browser (google/youtube/github/duckduckgo/bing).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "The search query text.",
        },
        engine: {
          type: Type.STRING,
          description: "Search engine (default 'google').",
        },
      },
      required: ["query"],
    },
  },
  {
    name: "desktopBrowserGetText",
    description: "Reads the text content of the current desktop browser page (optionally a specific element selector).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        selector: {
          type: Type.STRING,
          description: "Optional CSS selector to read text from; if omitted, reads the whole page body.",
        },
      },
      required: [],
    },
  },
  {
    name: "desktopBrowserReadElement",
    description: "Reads the text of a single element identified by snapshot ref or CSS selector.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: {
          type: Type.STRING,
          description: "The snapshot element ref (e.g. 'e3').",
        },
        selector: {
          type: Type.STRING,
          description: "Alternative CSS selector for the element.",
        },
      },
      required: [],
    },
  },
  {
    name: "desktopBrowserFillForm",
    description: "Fills form fields (object of selector -> value) and optionally submits.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        fields: {
          type: Type.OBJECT,
          description: "Object mapping CSS selectors to values to fill, e.g. {\"#email\": \"a@b.com\"}.",
        },
        submit: {
          type: Type.STRING,
          description: "Optional CSS selector of the submit button to click after filling.",
        },
      },
      required: ["fields"],
    },
  },
  {
    name: "desktopBrowserGoBack",
    description: "Navigates the desktop browser back one page.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "desktopBrowserGoForward",
    description: "Navigates the desktop browser forward one page.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "desktopBrowserRefresh",
    description: "Reloads the current page in the desktop browser.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "desktopBrowserOpenTab",
    description: "Opens a new tab in the desktop browser, optionally at a URL.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: {
          type: Type.STRING,
          description: "Optional URL to open the new tab at.",
        },
      },
      required: [],
    },
  },
  {
    name: "desktopBrowserCloseTab",
    description: "Closes the active tab in the desktop browser.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "desktopBrowserListTabs",
    description: "Lists all open tabs in the desktop browser with index, url and title.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "desktopBrowserSwitchTab",
    description: "Switches the desktop browser to the tab at the given index.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        index: {
          type: Type.INTEGER,
          description: "The tab index to switch to (0-based).",
        },
      },
      required: ["index"],
    },
  },
  {
    name: "desktopBrowserPressKey",
    description: "Presses a keyboard key in the desktop browser (Enter, Escape, Tab, ArrowDown, etc.).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        key: {
          type: Type.STRING,
          description: "The key name to press, e.g. 'Enter', 'Escape', 'Tab'.",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "desktopBrowserMediaControl",
    description: "Controls media playback in the desktop browser (play/pause/volume/mute/skip/fullscreen).",
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: {
          type: Type.STRING,
          description: "The media action.",
          enum: ["play", "pause", "volumeup", "volumedown", "mute", "unmute", "skip", "fullscreen", "exit_fullscreen"],
        },
      },
      required: ["action"],
    },
  },
  {
    name: "browserSnapshot",
    description: "Gets an accessibility snapshot of the desktop browser page to find elements by text and ref.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "browserType",
    description: "Type text into a field in the desktop browser. PREFERRED: use 'ref' from a desktopBrowserSnapshot to target the exact input field. Fallback: selector.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: {
          type: Type.STRING,
          description: "The text to type.",
        },
        ref: {
          type: Type.STRING,
          description: "Element ref from a snapshot, e.g. 'e2'. MOST RELIABLE — always prefer this.",
        },
        selector: {
          type: Type.STRING,
          description: "Optional CSS selector for the input field (fallback).",
        },
        clear: {
          type: Type.BOOLEAN,
          description: "Clear before typing (default true).",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "browserNavigate",
    description: "Navigates the desktop browser to a URL. Alias of desktopBrowserOpen.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        url: {
          type: Type.STRING,
          description: "The destination URL.",
        },
      },
      required: ["url"],
    },
  },
  {
    name: "browserGoBack",
    description: "Navigates the desktop browser back one page.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "browserGoForward",
    description: "Navigates the desktop browser forward one page.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "browserRefresh",
    description: "Reloads the current page in the desktop browser.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "browserGetText",
    description: "Reads the text content of the current desktop browser page.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        selector: {
          type: Type.STRING,
          description: "Optional CSS selector; if omitted reads the whole page.",
        },
      },
      required: [],
    },
  },
  {
    name: "browserListTabs",
    description: "Lists all open tabs in the desktop browser.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "browserSwitchTab",
    description: "Switches the desktop browser to the tab at the given index.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        index: {
          type: Type.INTEGER,
          description: "The tab index (0-based).",
        },
      },
      required: ["index"],
    },
  },
  {
    name: "browserPressKey",
    description: "Presses a keyboard key in the desktop browser.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        key: {
          type: Type.STRING,
          description: "The key name to press.",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "browserFillForm",
    description: "Fills form fields in the desktop browser and optionally submits.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        fields: {
          type: Type.OBJECT,
          description: "Object mapping CSS selectors to values.",
        },
        submit: {
          type: Type.STRING,
          description: "Optional submit button CSS selector.",
        },
      },
      required: ["fields"],
    },
  },
  {
    name: "browserClose",
    description: "Closes the current desktop browser instance.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "browserReadElement",
    description: "Reads the text of a single element by snapshot ref or CSS selector in the desktop browser.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: {
          type: Type.STRING,
          description: "Snapshot element ref (e.g. 'e3').",
        },
        selector: {
          type: Type.STRING,
          description: "Alternative CSS selector.",
        },
      },
      required: [],
    },
  },
  {
    name: "browserDoubleClick",
    description: "Double-clicks an element in the desktop browser by snapshot ref or text.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: {
          type: Type.STRING,
          description: "Snapshot element ref.",
        },
        text: {
          type: Type.STRING,
          description: "Exact text of the element to double-click.",
        },
      },
      required: [],
    },
  },
  {
    name: "browserRightClick",
    description: "Right-clicks an element in the desktop browser by snapshot ref or text.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: {
          type: Type.STRING,
          description: "Snapshot element ref.",
        },
        text: {
          type: Type.STRING,
          description: "Exact text of the element to right-click.",
        },
      },
      required: [],
    },
  },
  {
    name: "browserPageSearch",
    description: "Searches for text within the current desktop browser page.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: {
          type: Type.STRING,
          description: "The text to search for on the page.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "desktopBrowserDoubleClick",
    description: "Double-clicks an element in the desktop browser by snapshot ref or text.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: {
          type: Type.STRING,
          description: "Snapshot element ref.",
        },
        text: {
          type: Type.STRING,
          description: "Exact text of the element to double-click.",
        },
      },
      required: [],
    },
  },
  {
    name: "desktopBrowserRightClick",
    description: "Right-clicks an element in the desktop browser by snapshot ref or text.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: {
          type: Type.STRING,
          description: "Snapshot element ref.",
        },
        text: {
          type: Type.STRING,
          description: "Exact text of the element to right-click.",
        },
      },
      required: [],
    },
  },
  {
    name: "desktopBrowserPageSearch",
    description: "Searches for text within the current desktop browser page.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: {
          type: Type.STRING,
          description: "The text to search for on the page.",
        },
      },
      required: ["text"],
    },
  },
{
    name: "desktopBrowserSnapshot",
    description: "Capture an accessibility (ARIA) snapshot of the current browser page. Returns a tree of interactive elements, each tagged with a ref like [ref=e1], [ref=e2]. ALWAYS call this BEFORE clicking or typing to see the actual page structure — never guess selectors. The refs returned (e.g. 'e3') are used with desktopBrowserClick/desktopBrowserType for precise, human-level targeting.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: "desktopBrowserClick",
    description: "Click an element in the desktop automation browser. PREFERRED: use 'ref' from a prior desktopBrowserSnapshot (e.g. ref='e3') for precise targeting. Fallback: selector (CSS), text, or role+name. If the click times out, call desktopBrowserSnapshot again to refresh refs.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        ref: {
          type: Type.STRING,
          description: "Element ref from a desktopBrowserSnapshot, e.g. 'e3'. MOST RELIABLE — always prefer this.",
        },
        selector: {
          type: Type.STRING,
          description: "CSS selector (fallback only).",
        },
        text: {
          type: Type.STRING,
          description: "Visible text to click (fallback).",
        },
        role: {
          type: Type.STRING,
          description: "ARIA role e.g. 'button', 'link' (fallback).",
        },
        name: {
          type: Type.STRING,
          description: "Accessible name for the role (fallback).",
        },
      },
      required: [],
    },
  },
  {
    name: "desktopBrowserType",
    description: "Type text into a field in the desktop automation browser. PREFERRED: use 'ref' from a desktopBrowserSnapshot to target the exact input field. Fallback: selector. Clears the field by default before typing.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: {
          type: Type.STRING,
          description: "Text to type.",
        },
        ref: {
          type: Type.STRING,
          description: "Element ref from a snapshot, e.g. 'e2'. MOST RELIABLE — always prefer this.",
        },
        selector: {
          type: Type.STRING,
          description: "The selector ID of the input field.",
        },
      },
      required: ["text", "selector"],
    },
  },
  {
    name: "desktopBrowserClose",
    description: "Closes the current desktop browser instance.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: "desktopClickOnText",
    description: "Finds text on the computer screen and clicks on it.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: {
          type: Type.STRING,
          description: "The text to find and click.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "desktopTypeText",
    description: "Types text into the currently active window.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        text: {
          type: Type.STRING,
          description: "The text to type.",
        },
      },
      required: ["text"],
    },
  },
  {
    name: "desktopPressKey",
    description: "Presses a keyboard key.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        key: {
          type: Type.STRING,
          description: "The key name (e.g., enter, tab, escape, backspace).",
        },
      },
      required: ["key"],
    },
  },
  {
    name: "desktopScroll",
    description: "Scrolls the screen.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        direction: {
          type: Type.STRING,
          description: "The scroll direction.",
          enum: ["up", "down", "left", "right"],
        },
      },
      required: ["direction"],
    },
  },
  {
    name: "desktopScreenshot",
    description: "Takes a screenshot of the current screen.",
    parameters: {
      type: Type.OBJECT,
      properties: {},
      required: [],
    },
  },
  {
    name: "desktopOpenApp",
    description: "Opens an application on the computer.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        app_name: {
          type: Type.STRING,
          description: "The name of the application to open.",
        },
      },
      required: ["app_name"],
    },
  },
  {
    name: "volumeUp",
    description: "Increases the system volume.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "volumeDown",
    description: "Decreases the system volume.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "setVolume",
    description: "Sets the system volume to a specific level.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        level: {
          type: Type.INTEGER,
          description: "Volume level (0-100).",
        },
      },
      required: ["level"],
    },
  },
  {
    name: "muteToggle",
    description: "Toggles the system mute state.",
    parameters: { type: Type.OBJECT, properties: {}, required: [] },
  },
  {
    name: "requestPowerAction",
    description: "Requests a power action (shutdown, restart, sleep, lock) to get a confirmation token.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: {
          type: Type.STRING,
          description: "The power action to request.",
          enum: ["shutdown", "restart", "sleep", "lock"],
        },
      },
      required: ["action"],
    },
  },
  {
    name: "executePowerAction",
    description: "Executes a power action after user confirmation.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        action: {
          type: Type.STRING,
          description: "The power action to execute.",
          enum: ["shutdown", "restart", "sleep", "lock"],
        },
        token: {
          type: Type.STRING,
          description: "The confirmation token received from requestPowerAction.",
        },
      },
      required: ["action", "token"],
    },
  },
  {
    name: "desktopWebSearch",
    description: "Performs a web search on the desktop.",
    parameters: {
      type: Type.OBJECT,
      properties: {
        query: {
          type: Type.STRING,
          description: "The search query.",
        },
        engine: {
          type: Type.STRING,
          description: "Engine name (default 'google').",
        },
      },
      required: ["query"],
    },
  },
];
