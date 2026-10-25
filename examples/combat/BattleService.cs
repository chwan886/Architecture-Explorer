namespace Demo;

public sealed class BattleService
{
    public int StartTurn(Actor target, int amount)
    {
        return DamageCalculator.Apply(target, amount);
    }
}
