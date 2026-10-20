"""This file is data for a content-only analyzer, never imported."""
import os
os.environ["EXPLORER_ANALYZER_EXECUTED_TARGET"] = "forbidden"
raise RuntimeError("A source analyzer must never execute this fixture")


def health(actor):
    return actor['hp']


def hurt(actor, amount):
    if amount > 0:
        actor['hp'] -= amount
    return health(actor)


def unrelated(other):
    other['hp'] = 1
    return other['hp']


def shadow(health):
    return health({})


def ambiguous(actor):
    actor.damage(1)


def unicode(actor):
    label = '生命🙂'; return actor['hp']


def callbacks(actor):
    first = lambda: health(actor)
    second = lambda: health(actor)
    return first, second


def replaceable(actor):
    return health(actor)


health = external_function
