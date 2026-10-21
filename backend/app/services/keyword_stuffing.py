import fitz  # PyMuPDF

# A span's own colour counts as "white" at or above this per-channel value.
WHITE_CHANNEL_MIN = 250
# When inspecting what is actually rendered in a span's area, anything at or above this
# per-channel value is treated as blank page. Slightly looser than WHITE_CHANNEL_MIN so
# near-white page tints don't read as content.
RENDERED_BLANK_CHANNEL_MIN = 245
# Fraction of sampled pixels that must be non-blank for the area to count as having
# something visible behind the text. Deliberately low — a dark band or image behind a line
# of text covers most of the area, while genuinely invisible text leaves it pure white.
VISIBLE_PIXEL_RATIO = 0.02
# Upper bound on how many white spans get the render check, so a pathological file can't
# turn this into thousands of rasterisations. Well beyond any real resume's header/sidebar.
MAX_RENDER_CHECKS = 400
# At most this many pixels are sampled per span — enough to characterise the area.
MAX_PIXEL_SAMPLES = 600
# Keyword stuffing means a *block* of keywords, so a minimum volume of hidden text is
# required before declining anyone. Stray invisible fragments are common and innocent —
# some job-board exports carry a small hidden indexing layer, and odd glyph artifacts show
# up in converted files. Neither should cost a candidate their application.
MIN_HIDDEN_CHARS = 20
MIN_HIDDEN_WORDS = 3


def _renders_as_blank(page, bbox) -> bool:
    """True when the span's area on the rendered page is essentially blank white.

    White text is only hidden if there is nothing behind it. Rendering the area answers
    that directly and works regardless of *why* the background is dark — a filled
    rectangle, an image, a gradient. White text on a dark header band (every Naukri export
    and most two-column templates) renders mostly dark and is plainly visible; white text
    on a white page renders pure white and is the thing actually worth flagging.

    Returns False whenever the area can't be rendered or measured, so an unreadable PDF is
    never turned into an accusation of keyword stuffing.
    """
    try:
        rect = fitz.Rect(bbox) & page.rect
        if rect.is_empty or rect.is_infinite or rect.width < 1 or rect.height < 1:
            return False

        pix = page.get_pixmap(clip=rect, colorspace=fitz.csRGB, alpha=False)
        total = pix.width * pix.height
        if total == 0:
            return False

        data = pix.samples
        stride = max(1, total // MAX_PIXEL_SAMPLES)
        sampled = 0
        non_blank = 0
        for i in range(0, total, stride):
            offset = i * 3
            r, g, b = data[offset], data[offset + 1], data[offset + 2]
            sampled += 1
            if (
                r < RENDERED_BLANK_CHANNEL_MIN
                or g < RENDERED_BLANK_CHANNEL_MIN
                or b < RENDERED_BLANK_CHANNEL_MIN
            ):
                non_blank += 1

        if sampled == 0:
            return False
        return (non_blank / sampled) < VISIBLE_PIXEL_RATIO
    except Exception:  # noqa: BLE001 - a render failure must never imply stuffing
        return False


def detect_keyword_stuffing(pdf_content: bytes) -> dict:
    """Parses a PDF using PyMuPDF to identify text spans that are:
    1. Invisible — white text with nothing behind it to make it readable.
    2. Microscopic (font size less than 2.0pt) to bypass resume filters.

    White text is *not* evidence on its own: dark header bands and coloured sidebars with
    white lettering are standard in job-board exports and two-column templates, and judging
    on text colour alone rejected perfectly ordinary resumes. Each white span is therefore
    checked against what is actually rendered behind it (see _renders_as_blank).

    Returns a dict containing:
      - 'detected' (bool): True if keyword stuffing was detected.
      - 'reason' (str | None): Description of the stuffed elements and pages.
      - 'stuffed_text' (str): Sample of the hidden/tiny text extracted.
    """
    try:
        doc = fitz.open(stream=pdf_content, filetype="pdf")
    except Exception as exc:
        return {
            "detected": False,
            "reason": f"Failed to open PDF for validation: {exc}",
            "stuffed_text": "",
        }

    stuffed_spans = []
    render_checks = 0

    try:
        for page_idx, page in enumerate(doc):
            text_dict = page.get_text("dict")
            for block in text_dict.get("blocks", []):
                if block.get("type") != 0:  # Skip non-text blocks (like images)
                    continue
                for line in block.get("lines", []):
                    for span in line.get("spans", []):
                        text = (span.get("text") or "").strip()
                        if not text:
                            continue

                        size = span.get("size", 12.0)
                        color_val = span.get("color", 0)

                        # Extract RGB color channels from decimal color value
                        r = (color_val >> 16) & 255
                        g = (color_val >> 8) & 255
                        b = color_val & 255

                        is_tiny = size < 2.0
                        is_white = (
                            r >= WHITE_CHANNEL_MIN
                            and g >= WHITE_CHANNEL_MIN
                            and b >= WHITE_CHANNEL_MIN
                        )

                        # White only counts once we've confirmed there's nothing behind it.
                        # Past the render budget, white text is left alone rather than
                        # assumed guilty.
                        is_hidden_white = False
                        if is_white and not is_tiny:
                            if render_checks < MAX_RENDER_CHECKS:
                                render_checks += 1
                                is_hidden_white = _renders_as_blank(page, span.get("bbox"))

                        if is_hidden_white or is_tiny:
                            stuffed_spans.append({
                                "text": text,
                                "page": page_idx + 1,
                                "reason": "tiny_text" if is_tiny else "white_text",
                                "size": size,
                                "color": f"#{r:02x}{g:02x}{b:02x}",
                            })
    finally:
        doc.close()

    # Below the volume threshold this is an artifact, not an attempt to game the filter.
    hidden_corpus = " ".join(s["text"] for s in stuffed_spans).strip()
    if len(hidden_corpus) < MIN_HIDDEN_CHARS or len(hidden_corpus.split()) < MIN_HIDDEN_WORDS:
        stuffed_spans = []

    if stuffed_spans:
        stuffed_text_str = " | ".join(s["text"] for s in stuffed_spans[:10])
        if len(stuffed_spans) > 10:
            stuffed_text_str += f" ... (and {len(stuffed_spans) - 10} more)"

        kinds = {s["reason"] for s in stuffed_spans}
        if kinds == {"white_text"}:
            what = "text hidden against the background"
        elif kinds == {"tiny_text"}:
            what = "text too small to read"
        else:
            what = "text hidden against the background, and text too small to read"

        pages = _format_pages(sorted({s["page"] for s in stuffed_spans}))
        sample = _sample_for_humans(stuffed_spans)

        return {
            "detected": True,
            # Written for the HR user who sees this next to the candidate, not for a log:
            # what was found, why it matters, and what to do about it. The sample is the
            # most useful part — it's what lets someone tell deliberate keyword padding
            # from a formatting quirk at a glance.
            "reason": (
                f"Unreadable {what} on {pages}{sample} "
                "This is sometimes used to pad a resume with keywords the reader can't see. "
                "Open the original file to check: if it looks like a formatting artifact, "
                "ask the candidate for a different version (for example a PDF exported from "
                "Word) and upload it again."
            ),
            "stuffed_text": stuffed_text_str,
        }

    return {"detected": False, "reason": None, "stuffed_text": ""}


def _format_pages(pages: list[int]) -> str:
    """'page 1' / 'pages 1 and 3' / 'pages 1, 2 and 5' — the raw list repr that used to go
    out ("on page(s) [1]") read like a bug to the people seeing it."""
    if len(pages) == 1:
        return f"page {pages[0]}"
    if len(pages) == 2:
        return f"pages {pages[0]} and {pages[1]}"
    return f"pages {', '.join(str(p) for p in pages[:-1])} and {pages[-1]}"


def _sample_for_humans(stuffed_spans: list[dict], limit: int = 90) -> str:
    """A short quote of what was actually found, so the reason is checkable rather than
    something to take on trust. Empty string if there's nothing meaningful to quote."""
    joined = " ".join(s["text"] for s in stuffed_spans[:10]).strip()
    joined = " ".join(joined.split())
    if not joined:
        return "."
    if len(joined) > limit:
        joined = joined[:limit].rstrip() + "…"
    return f': "{joined}".'
