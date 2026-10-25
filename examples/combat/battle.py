"""Static input for the explorer. The analyzer never imports this module."""

from rules import damage


def start_turn(actor, amount):
    return damage(actor, amount)
