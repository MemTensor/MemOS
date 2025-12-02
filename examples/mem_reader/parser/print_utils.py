import pprint


def pretty_print_dict(d: dict):
    text = pprint.pformat(d, indent=2, width=120)
    border = "═" * (max(len(line) for line in text.split("\n")) + 4)

    print(f"╔{border}╗")
    for line in text.split("\n"):
        print(f"║  {line.ljust(len(border) - 2)}  ║")
    print(f"╚{border}╝")
