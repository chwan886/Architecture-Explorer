"""A separate Python example; no cross-language transport is implied."""


def clamp_health(value):
    return max(0, value)


def damage(actor, amount):
    if amount > 0:
        actor['hp'] = clamp_health(actor['hp'] - amount)
    return actor['hp']
