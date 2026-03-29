class EligibilityService:
    @staticmethod
    def is_eligible(age, subscription_status):
        """
        Criteria:
        - Age must be 18 or older.
        - Subscription status must be 'premium' or 'active'.
        """
        if age is None:
            return False
            
        try:
            age_int = int(age)
        except (ValueError, TypeError):
            return False
            
        if age_int < 18:
            return False
            
        if subscription_status not in ['premium', 'active']:
            return False
            
        return True
