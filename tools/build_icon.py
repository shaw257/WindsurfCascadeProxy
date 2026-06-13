from pathlib import Path

from PIL import Image


ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "assets" / "cascade-proxy-icon-source.png"
PNG_OUT = ROOT / "assets" / "cascade-proxy-icon.png"
ICO_OUT = ROOT / "assets" / "cascade-proxy-icon.ico"


def remove_white_corners(image: Image.Image) -> Image.Image:
    rgba = image.convert("RGBA")
    pixels = []
    for red, green, blue, _ in rgba.get_flattened_data():
        spread = max(red, green, blue) - min(red, green, blue)
        whiteness = min(red, green, blue)
        if spread <= 18 and whiteness >= 220:
            alpha = max(0, min(255, (245 - whiteness) * 10))
        else:
            alpha = 255
        pixels.append((red, green, blue, alpha))
    rgba.putdata(pixels)
    return rgba


def main() -> None:
    image = Image.open(SOURCE)
    transparent = remove_white_corners(image)
    transparent.save(PNG_OUT, optimize=True)

    icon_source = transparent.resize((256, 256), Image.Resampling.LANCZOS)
    icon_source.save(
        ICO_OUT,
        format="ICO",
        sizes=[(16, 16), (24, 24), (32, 32), (48, 48), (64, 64), (128, 128), (256, 256)],
    )
    print(PNG_OUT)
    print(ICO_OUT)


if __name__ == "__main__":
    main()
