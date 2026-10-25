namespace Demo;

public sealed class Actor
{
    public int Health = 100;

    public void TakeDamage(int amount)
    {
        if (amount > 0)
            Health = System.Math.Max(0, Health - amount);
    }
}
