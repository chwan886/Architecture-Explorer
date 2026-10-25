namespace Demo;

public static class DamageCalculator
{
    public static int Apply(Actor target, int amount)
    {
        target.TakeDamage(amount);
        return target.Health;
    }
}
